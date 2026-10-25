// Where the laptop server is. When the laptop serves this page itself, it is this page's own address ("").
// The web demo (on Vercel) is built with API_BASE set to the tunnel that reaches the laptop, and ?api=<url>
// overrides it for one visit, so a new tunnel address can be tried without a redeploy.
const fromUrl = new URLSearchParams(location.search).get("api");

export const API_BASE = (fromUrl || process.env.API_BASE || "").replace(/\/+$/, "");

// The full address of a server path such as "/api/scene".
export const api = path => API_BASE + path;

// True on the web demo, where visitors have no FreeCAD screen and the 3D preview opens by itself.
export const REMOTE = API_BASE !== "";
