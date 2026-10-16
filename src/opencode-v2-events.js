const validID = (id) => typeof id === "string" && id.length > 0;
const validSessionID = (id) => validID(id) && id !== "global";

// Only inhibition state crosses this boundary; model and user content is discarded.
export function normalizeOpenCodeV2Event(event) {
  const data = event?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const sessionID = event.type === "form.created" ? data.form?.sessionID : data.sessionID;
  if (!validSessionID(sessionID)) return null;
  const emit = (type, fields = {}) => ({ type, properties: { sessionID, ...fields } });
  const status = (type) => emit("session.status", { status: { type } });

  switch (event.type) {
    case "session.created":
      if (data.parentID !== undefined && !validSessionID(data.parentID)) return null;
      return { type: "session.created", properties: { info: {
        id: sessionID, ...(data.parentID === undefined ? {} : { parentID: data.parentID }),
      } } };
    case "session.execution.started":
    case "session.step.started":
      return status("busy");
    case "session.retry.scheduled":
      return status("retry");
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.idle":
      return emit("session.idle");
    case "session.deleted":
      return emit("session.deleted");
    case "session.status":
      return ["busy", "retry", "idle"].includes(data.status?.type) ? status(data.status.type) : null;
    case "permission.asked":
      return validID(data.id) ? emit("permission.asked", { id: data.id }) : null;
    case "permission.replied":
      return validID(data.requestID) ? emit("permission.replied", { requestID: data.requestID }) : null;
    case "form.created":
      return validID(data.form?.id) ? emit("question.asked", { id: data.form.id }) : null;
    case "form.replied":
    case "form.cancelled":
      return validID(data.id) ? emit(event.type === "form.replied" ? "question.replied" : "question.rejected", {
        requestID: data.id,
      }) : null;
    default:
      return null;
  }
}
