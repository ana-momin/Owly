// The bug this demo exists to show: every signup fails on the server.
// Nothing is read, nothing is stored, nothing is sent anywhere.
export default function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  res.status(500).json({
    error: "TypeError: Cannot read properties of undefined (reading 'rows')",
    at: "createAccount (api/signup.js:31:18)"
  });
}
