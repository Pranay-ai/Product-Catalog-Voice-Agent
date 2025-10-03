import "./app.css";
import { useCallSession } from "./hooks/useCallSession";

export default function App() {
  const {
    status,
    opener,
    finalText,
    asr,
    log,
    startCall,
    endCall,
    ttsSupported,
  } =
    useCallSession();

  return (
    <div className="phone-wrap">
      <div className="status-bar">
        <div className="title">Voice Call</div>
        <div className={`pill ${status}`}>{status}</div>
      </div>

      <div className="transcripts">
        <div className="box">
          <div className="label">Opener</div>
          <div className="text">
            {opener
              ? ttsSupported
                ? "Playing opener audio"
                : opener
              : "—"}
          </div>
        </div>
        <div className="box">
          <div className="label">Assistant</div>
          <div className="text">
            {finalText
              ? ttsSupported
                ? "Playing assistant audio"
                : finalText
              : "—"}
          </div>
        </div>
        <div className="box">
          <div className="label">You (ASR)</div>
          <div className="text faint">{asr || "—"}</div>
        </div>
      </div>

      <div className="controls">
        <button
          className="btn call"
          onClick={startCall}
          disabled={status !== "idle" && status !== "error"}
        >
          Call
        </button>
        <button
          className="btn end"
          onClick={endCall}
          disabled={status !== "in_call" && status !== "processing"}
        >
          End
        </button>
      </div>

      <pre className="debug">{log}</pre>
    </div>
  );
}
