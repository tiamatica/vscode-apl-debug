/*---------------------------------------------------------
 * Copyright (C) Tiamatica. All rights reserved.
 *--------------------------------------------------------*/

import { AplDebugSession } from './aplDebug';

import * as fs from 'fs';
import * as path from 'path';
import * as Net from 'net';
import { FileAccessor } from './aplRuntime';

/*
 * debugAdapter.js is the entrypoint of the debug adapter when it runs as a separate process.
 */

/*
 * Since here we run the debug adapter as a separate ("external") process, it has no access to VS Code API.
 * So we can only use node.js API for accessing files.
 */
const fsAccessor:  FileAccessor = {
	async checkExists(filePath: string, timeout: number) {
		return new Promise(function (resolve, reject) {
	
			var timer = setTimeout(function () {
				watcher.close();
				reject(new Error('File did not exists and was not created during the timeout.'));
			}, timeout);
	
			fs.access(filePath, fs.constants.R_OK, function (err) {
				if (!err) {
					clearTimeout(timer);
					watcher.close();
					resolve(true);
				}
			});
	
			var dir = path.dirname(filePath);
			var basename = path.basename(filePath);
			var watcher = fs.watch(dir, function (eventType, filename) {
				if (eventType === 'rename' && filename === basename) {
					clearTimeout(timer);
					watcher.close();
					resolve(true);
				}
			});
		});
	},
	async deleteFile(filePath: string) {
		return new Promise((resolve, reject) => {
			fs.rm(filePath, {force: true }, (err) => {
				if (err) {
					reject(err);
				}
				resolve(true);
			});
		});
	},
	async readFile(path: string): Promise<string> {
		return new Promise((resolve, reject) => {
			fs.readFile(path, (err, data) => {
				if (err) {
					reject(err);
				} else {
					resolve(data.toString());
				}
			});
		});
	},
};

/*
 * When the debug adapter is run as an external process,
 * normally the helper function DebugSession.run(...) takes care of everything:
 *
 * 	AplDebugSession.run(AplDebugSession);
 *
 * but here the helper is not flexible enough to deal with a debug session constructors with a parameter.
 * So for now we copied and modified the helper:
 */

// first parse command line arguments to see whether the debug adapter should run as a server
let port = 0;
const args = process.argv.slice(2);
args.forEach(function (val, index, array) {
	const portMatch = /^--server=(\d{4,5})$/.exec(val);
	if (portMatch) {
		port = parseInt(portMatch[1], 10);
	}
});

if (port > 0) {

	// start a server that creates a new session for every connection request
	console.error(`waiting for debug protocol on port ${port}`);
	Net.createServer((socket) => {
		console.error('>> accepted connection from client');
		socket.on('end', () => {
			console.error('>> client connection closed\n');
		});
		const session = new AplDebugSession(fsAccessor);
		session.setRunAsServer(true);
		session.start(socket, socket);
	}).listen(port);
} else {

	// start a single session that communicates via stdin/stdout
	const session = new AplDebugSession(fsAccessor);
	process.on('SIGTERM', () => {
		session.shutdown();
	});
	session.start(process.stdin, process.stdout);
}
