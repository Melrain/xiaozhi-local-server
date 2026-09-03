let socket = null;
let playbackPort = null;

function postState(state) {
  self.postMessage({ type: "state", state });
}

function closeSocket() {
  if (!socket) return;
  socket.onopen = null;
  socket.onclose = null;
  socket.onerror = null;
  socket.onmessage = null;
  socket.close();
  socket = null;
}

function disconnect() {
  closeSocket();
  postState("idle");
}

function connect(url) {
  closeSocket();
  postState("connecting");

  const next = new WebSocket(url);
  socket = next;
  next.binaryType = "arraybuffer";

  next.onopen = () => {
    if (socket === next) postState("live");
  };

  next.onerror = () => {
    if (socket === next) {
      self.postMessage({ type: "error", message: "试听流连接失败" });
    }
  };

  next.onclose = () => {
    if (socket === next) {
      socket = null;
      postState("idle");
    }
  };

  next.onmessage = (event) => {
    if (socket !== next) return;

    if (typeof event.data === "string") {
      try {
        const meta = JSON.parse(event.data);
        const sampleRate = Number(meta.sampleRate) || 16000;
        playbackPort?.postMessage({ type: "hello", sampleRate });
        self.postMessage({ type: "hello", sampleRate });
      } catch {
        // ignore non-json control frames
      }
      return;
    }

    const pcm = event.data;
    if (!(pcm instanceof ArrayBuffer) || pcm.byteLength < 2) return;
    playbackPort?.postMessage({ type: "pcm", pcm }, [pcm]);
  };
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "bind-playback" && event.ports[0]) {
    playbackPort = event.ports[0];
    return;
  }
  if (message?.type === "connect" && typeof message.url === "string") {
    connect(message.url);
    return;
  }
  if (message?.type === "disconnect") {
    disconnect();
  }
};
