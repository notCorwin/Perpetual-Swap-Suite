import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectOperationBoundaries, checkOperationBoundaries } from '../../scripts/check-operation-boundaries.mjs'

test('application child execution and SQLite construction cannot bypass their recorded boundary', () => {
  assert.deepEqual(checkOperationBoundaries(), [])
  for (const source of [
    "import { Worker as Background } from 'node:worker_threads'; new Background(url)",
    "import * as workers from 'node:worker_threads'; new workers.Worker(url)",
    "import { DatabaseSync as DB } from 'node:sqlite'; new DB(path)",
    "const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(path)",
    "import sqlite from 'node:sqlite'; new sqlite.DatabaseSync(path)",
    "import { fork as child } from 'node:child_process'; child(file)",
  ]) assert.equal(inspectOperationBoundaries(source, 'electron/services/example.js').length, 1, source)
  assert.deepEqual(inspectOperationBoundaries('createOperationWorker(url); openRecordedDatabase(DatabaseSync, path)', 'electron/services/example.js'), [])
})


test('unsupported native UDP constructors, bind/multicast and HTTP2 server/push paths cannot bypass capability scope', () => {
  for(const source of [
    "import dgram from 'node:dgram'; new dgram.Socket('udp4')",
    "import { Socket as Datagram } from 'node:dgram'; new Datagram('udp4')",
    "import * as udp from 'node:dgram'; const Alias=udp.Socket; new Alias('udp4')",
    "const {Socket: Datagram}=await import('node:dgram'); new Datagram('udp4')",
    "const udp=require('dgram'); const {Socket: Alias}=udp; new Alias('udp4')",
    "import {createSocket as create} from 'node:dgram'; const socket=create('udp4'); socket.bind(1000)",
    "import udp from 'node:dgram'; const socket=udp.createSocket('udp4'); const alias=socket; alias.addMembership('224.0.0.1')",
    "import http2 from 'node:http2'; http2.createServer()",
    "import {createSecureServer as server} from 'node:http2'; const alias=server; alias()",
    "const {createServer: server}=await import('node:http2'); server()",
    "const alias=stream.pushStream; alias({},callback)",
    "stream.pushStream({':path':'/'}, callback)",
    "const {pushStream: push}=stream; push({':path':'/'}, callback)",
  ])assert.equal(inspectOperationBoundaries(source,'electron/services/example.js').length,1,source)
  assert.deepEqual(inspectOperationBoundaries("import udp from 'node:dgram';const socket=udp.createSocket('udp4');socket.send('x',1234,'127.0.0.1');socket.close()",'electron/services/example.js'),[])
  assert.deepEqual(inspectOperationBoundaries("import {connect} from 'node:http2';const client=connect('http://localhost');client.request({':path':'/'})",'electron/services/example.js'),[])
  assert.deepEqual(checkOperationBoundaries(),[])
})
