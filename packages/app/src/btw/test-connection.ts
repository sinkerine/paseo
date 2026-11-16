import { DaemonClient, type DaemonTransport } from "@getpaseo/client/internal/daemon-client";

/** An inert socket boundary; connection status still comes from the real client handshake. */
export function btwTestConnection() {
  let receive = (_data: string) => {};
  let open = () => {};
  let close = () => {};
  const transport: DaemonTransport = {
    send(data) {
      if (JSON.parse(String(data)).type === "hello") {
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "host",
                hostname: null,
                version: null,
              },
            },
          }),
        );
      }
    },
    close() {},
    onMessage(handler) {
      receive = (data) => {
        void handler(data, false);
      };
      return () => {
        receive = () => {};
      };
    },
    onOpen(handler) {
      open = handler;
      return () => {
        open = () => {};
      };
    },
    onClose(handler) {
      close = handler;
      return () => {
        close = () => {};
      };
    },
    onError() {
      return () => {};
    },
  };
  const client = new DaemonClient({
    url: "ws://127.0.0.1:1/ws",
    clientId: "btw-reconnect-unit",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  return {
    client,
    async connect() {
      const ready = client.connect();
      open();
      await ready;
    },
    disconnect() {
      close();
    },
  };
}
