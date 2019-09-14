const WebSocket = require('ws')
const ipfsClient = require('ipfs-http-client')
const HDKey = require('hdkey')
const crypto = require('crypto')
const qs = require('querystring')

const { IPFS_WRITE_OPTS, IPFS_MSG_PATH, RESPONSE_TIMEOUT } = require('./p2p')

const hashByIdentifier = new Map()
const connsByIdentifier = new Map()

function onConnection(ws) {
	ws.on('message', data => {
		try {
			const { xpub, sig, msg } = JSON.parse(data)
			const hdkey = HDKey.fromExtendedKey(xpub)
			const hash = crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
			if (!hdkey.verify(hash, Buffer.from(sig, 'hex'))) {
				throw new Error('invalid signature')
			}
			// @TODO more checks
			if (msg) onMessage(ws, xpub, msg).catch(e => console.error(e))
		} catch(e) {
			// catches the parse and the msg verification
			// @TODO better way to do this
			console.error(e)
		}
	})
	ws.on('close', () => console.log('disconnected'))
}

// @TODO pin
async function onMessage(socket, xpub, msg) {
	if (msg.type === 'Publish') {
		const identifier = `${xpub.slice(4, 16)}.${msg.identifier}`
		const conn = connsByIdentifier.get(identifier)
		if (conn && conn.socket !== socket) throw new Error('only one connection per addon allowed')
		if (!conn) {
			connsByIdentifier.set(identifier, { socket, requests: new Map() })
			socket.on('close', () => connsByIdentifier.delete(identifier))
		}
		console.log(connsByIdentifier)
		hashByIdentifier.set(identifier, msg.hash)
		await ipfs.files.write(`${IPFS_MSG_PATH}/${identifier}`, Buffer.from(JSON.stringify(msg)), IPFS_WRITE_OPTS)
	}
	if (msg.type === 'Response') {
		// @TODO
	}
}

async function readCachedMsgs() {
	const files = await ipfs.files.ls(`/${IPFS_MSG_PATH}`)
	// @TODO: warning: this doesn't consider whether the contents are files or not
	for (let file of files) {
		const identifier = file.name
		const buf = await ipfs.files.read(`/${IPFS_MSG_PATH}/${identifier}`)
		const msg = JSON.parse(buf.toString())
		hashByIdentifier.set(identifier, msg.hash)
	}
}

// Server part
// @TODO handle caching information
const express = require('express')
const app = express()
const ipfs = ipfsClient('localhost', '5001', { protocol: 'http' })

app.use('/:identifier', async function(req, res) {
	res.setHeader('content-type', 'application/json')
	const identifier = req.params.identifier.trim()
	const hash = hashByIdentifier.get(identifier)
	if (hash) {
		const path = `/ipfs/${hash}${req.url}`
		ipfs.catReadableStream(path)
			.on('error', e => {
				if (e.statusCode === 500 && e.message.startsWith('no link named'))
					handleNotFound(identifier, req, res, () => res.status(404).json({ err: 'not found' }))
				else
					throw e
			})
			.pipe(res)
	} else {
		res.status(404).json({ err: 'no addon with that identifier' })
	}
})

function handleNotFound(identifier, req, res) {
	const parsed = parseRequest(req.url)
	if (!parsed) {
		res.status(400).json({ err: 'failed to parse request' })
		return
	}

	const conn = connsByIdentifier.get(identifier)
	if (!conn) {
		res.status(502).json({ err: 'upstream addon publisher is disconnected' })
		return
	}

	const waiting = conn.requests.get(req.url)
	let promise
	if (waiting) {
		promise = waiting.promise
	} else {
		let onResponse
		promise = new Promise((resolve, reject) => {
			const t = setTimeout(() => reject({ isTimeout: true }), RESPONSE_TIMEOUT)
			onResponse = resp => {
				clearTimeout(t)
				resolve(resp)
			}

		})
		conn.requests.set(req.url, { promise, onResponse })
		// The catch is needed otherwise it's an uncaught promise
		promise.catch(() => null).finally(() => conn.requests.delete(req.url))
		conn.socket.send(JSON.stringify({ msg: { type: 'Request', req: parsed } }))
	}

	promise
		.then(resp => res.status(200).json(resp))
		.catch(err => {
			if (err.isTimeout) res.status(504).json({ err: 'addon timed out' })
			else {
				console.log(err)
				res.status(500).json({ err: 'unknown error' })
			}
		})
}

setInterval(() => console.log(connsByIdentifier), 3000)

function parseRequest(url) {
	if (!url.startsWith('/')) return null
	if (!url.endsWith('.json')) return null
	const segments = url.slice(1, -5).split('/')
	if (segments.length === 3) return segments
	if (segments.length === 4) return [ ...segments.slice(0, 3), qs.parse(segments[3]) ]
	return null
}


// Initialize
async function init() {
	// replay previous Publish messages
	await readCachedMsgs()

	// and start listening on the WebSocket
	// @TODO ports to not be hardcoded
	const wss = new WebSocket.Server({ port: 14001 })
	wss.on('connection', onConnection)

	app.listen(3006)
}

init().catch(e => console.error(e))
