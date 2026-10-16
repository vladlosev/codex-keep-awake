const ACTIVE_STATUSES = new Set(["busy", "retry"]);

export class OpenCodeActivityTracker {
  #sessions = new Map();

  handle(event) {
    const properties = event?.properties;
    if (!properties || typeof properties !== "object") return this.isRequired();

    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.#upsertSession(properties.info);
        break;
      case "session.status":
        if (typeof properties.sessionID === "string" && ACTIVE_STATUSES.has(properties.status?.type)) {
          this.#session(properties.sessionID).status = properties.status.type;
        } else if (typeof properties.sessionID === "string" && properties.status?.type === "idle") {
          this.#finishSession(properties.sessionID);
        }
        break;
      case "session.idle":
      case "session.error":
        if (typeof properties.sessionID === "string") this.#finishSession(properties.sessionID);
        break;
      case "session.deleted":
        this.#deleteSession(properties.info?.id ?? properties.sessionID);
        break;
      case "permission.asked":
        this.#addWait("permission", properties);
        break;
      case "permission.replied":
        this.#removeWait("permission", properties);
        break;
      case "question.asked":
        this.#addWait("question", properties);
        break;
      case "question.replied":
      case "question.rejected":
        this.#removeWait("question", properties);
        break;
      default:
        break;
    }

    return this.isRequired();
  }

  isRequired() {
    for (const session of this.#sessions.values()) {
      if (!ACTIVE_STATUSES.has(session.status) || session.waits.size > 0) continue;
      if (this.#hasWaitingDescendant(session.id)) continue;
      return true;
    }
    return false;
  }

  #session(id) {
    let session = this.#sessions.get(id);
    if (!session) {
      session = { id, parentID: null, status: "idle", waits: new Set() };
      this.#sessions.set(id, session);
    }
    return session;
  }

  #upsertSession(info) {
    if (!info || typeof info.id !== "string") return;
    const session = this.#session(info.id);
    session.parentID = typeof info.parentID === "string" ? info.parentID : null;
  }

  #finishSession(id) {
    const session = this.#session(id);
    session.status = "idle";
    session.waits.clear();
  }

  #addWait(kind, properties) {
    if (typeof properties.sessionID !== "string" || typeof properties.id !== "string") return;
    this.#session(properties.sessionID).waits.add(`${kind}:${properties.id}`);
  }

  #removeWait(kind, properties) {
    if (typeof properties.sessionID !== "string" || typeof properties.requestID !== "string") return;
    this.#session(properties.sessionID).waits.delete(`${kind}:${properties.requestID}`);
  }

  #hasWaitingDescendant(ancestorID) {
    for (const candidate of this.#sessions.values()) {
      if (candidate.waits.size > 0 && this.#isDescendant(candidate.id, ancestorID)) return true;
    }
    return false;
  }

  #isDescendant(sessionID, ancestorID) {
    let parentID = this.#sessions.get(sessionID)?.parentID;
    const visited = new Set();
    while (parentID && !visited.has(parentID)) {
      if (parentID === ancestorID) return true;
      visited.add(parentID);
      parentID = this.#sessions.get(parentID)?.parentID;
    }
    return false;
  }

  #deleteSession(id) {
    if (typeof id !== "string") return;
    const removed = new Set([id]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const session of this.#sessions.values()) {
        if (!removed.has(session.id) && removed.has(session.parentID)) {
          removed.add(session.id);
          foundDescendant = true;
        }
      }
    }
    for (const sessionID of removed) this.#sessions.delete(sessionID);
  }
}
