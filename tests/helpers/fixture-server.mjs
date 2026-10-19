/** A fixture owns accepted TCP connections, including sockets that have not
 * sent HTTP headers yet and sockets upgraded out of the HTTP connection pool. */
export function ownFixtureServer(server) {
  const sockets = new Set()
  let closing = false, closeTask
  server.on('connection', socket => {
    if (closing) { socket.destroy(); return }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return {
    get closing() { return closing },
    get connections() { return sockets.size },
    close() {
      if (closeTask) return closeTask
      closing = true
      closeTask = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        // server.close() leaves incomplete HTTP requests and upgraded sockets
        // alive. Stop admission before destroying this fixture's connections.
        for (const socket of sockets) socket.destroy()
      })
      return closeTask
    },
  }
}
