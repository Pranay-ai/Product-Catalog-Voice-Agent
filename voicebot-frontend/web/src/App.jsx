import "./app.css";
import { useCallSession } from "./hooks/useCallSession";

export default function App() {
  const { status, startCall, endCall, userSpeaking, botSpeaking } =
    useCallSession();

  const canStart = status === "idle" || status === "error";
  const canEnd = ["in_call", "processing", "ending"].includes(status);
  const orbState = userSpeaking ? "user" : botSpeaking ? "bot" : "idle";

  return (
    <main className="stage">
      <div className={`orb orb--${orbState}`} aria-hidden />
      <button
        type="button"
        className="action-button start"
        onClick={startCall}
        disabled={!canStart}
      >
        Start
      </button>
      <button
        type="button"
        className="action-button end"
        onClick={endCall}
        disabled={!canEnd}
      >
        End
      </button>
    </main>
  );
}
