/**
 * The end of a message read from a libp2p stream, for the readers in handshake.ts and federation-protocol.ts.
 *
 * Both read a whole message with `for await (const chunk of stream)`, which ends on the one `remoteCloseWrite` event the
 * stream fires when the remote closes its write side. libp2p starts a protocol handler only after its own work on the
 * new stream (protocol negotiation, a peer-store write), and on a busy node the request AND its close can both land in
 * that gap: the bytes wait in the stream's read buffer, the event has already fired with no one listening, and the loop
 * got the bytes and then waited for an end that never came. The handler gave up at its 5 s read timeout and reset the
 * stream, so a relayed line was never stored and the sending node logged "The stream has been reset"
 * (test-federation-hardening on CI: main fa076db5 run 43470982789, and runs on 3 and 10 Nov).
 */

/**
 * The byte count of a message the remote has ALREADY sent in full (its write side closed, the stream still open) when
 * the reader starts, or null while it may still be sending. The reader stops once it has that many bytes.
 *
 * Every byte is then in the stream's read buffer: the remote sent them before its close, in order, and none was handed
 * out with no listener to take it. Only a real libp2p stream carries these fields; a test's stand-in stream without them
 * gets null and reads as before.
 */
export function alreadyClosedBytes(stream: any): number | null {
    return stream?.status === 'open' && stream.remoteWriteStatus === 'closed' && typeof stream.readBufferLength === 'number'
        ? stream.readBufferLength
        : null;
}
