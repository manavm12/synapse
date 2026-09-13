export function createBrowserSessionAuth({
  sessionVerifier,
  logger,
  event = "browser_session_rejected",
}) {
  return async function browserSession(req, res, next) {
    res.set("Cache-Control", "no-store");
    const value = req.headers.authorization;
    const token =
      typeof value === "string" && value.startsWith("Bearer ")
        ? value.slice(7).trim()
        : null;
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      req.synapseSession = await sessionVerifier.verifyAccessToken(token);
      next();
    } catch (error) {
      logger?.info(event, {
        request_id: req.requestId ?? null,
        error_type: error.name,
      });
      res.status(401).json({ error: "unauthorized" });
    }
  };
}
