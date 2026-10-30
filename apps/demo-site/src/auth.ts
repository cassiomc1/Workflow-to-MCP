import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
export function createAuthRoutes(
  tickets: Record<string, { status: string; summary: string }>,
) {
  const sessions = new Map<
    string,
    { access: string; session: string; indexed: string }
  >();
  let writes = 0,
    refreshes = 0;
  const cookie = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("wf_demo_sid="))
      ?.slice("wf_demo_sid=".length);
  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const proofScript = `async function storageProof(){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('demo-auth',1);r.onupgradeneeded=()=>r.result.createObjectStore('tokens');r.onsuccess=()=>resolve(r.result);r.onerror=reject;});const indexed=await new Promise((resolve,reject)=>{const r=db.transaction('tokens').objectStore('tokens').get('access');r.onsuccess=()=>resolve(r.result);r.onerror=reject;});db.close();return {'X-Demo-Access':localStorage.getItem('demo_access_token')||'','X-Demo-Session':sessionStorage.getItem('demo_session_token')||'','X-Demo-Indexed':indexed||''};}`;
  return {
    get writes() {
      return writes;
    },
    get refreshes() {
      return refreshes;
    },
    expireAll() {
      sessions.clear();
    },
    secrets() {
      return [...sessions].flatMap(([sid, state]) => [
        sid,
        state.access,
        state.session,
        state.indexed,
      ]);
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!u.pathname.startsWith("/auth/")) return false;
      res.setHeader("Cache-Control", "no-store");
      if (u.pathname === "/auth/login" && req.method === "GET") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Dedicated demo login</title><main><h1>Sign in to the synthetic CRM</h1><p>Synthetic credentials: demo / demo-password / 123456. This fixture stores no real accounts.</p><form id="login"><label>Demo user<input name="user" autocomplete="username"></label><label>Demo password<input name="password" type="password" autocomplete="current-password"></label><label>One-time code<input name="otp" autocomplete="one-time-code"></label><button>Sign in</button></form><p id="error"></p></main><script>document.getElementById('login').onsubmit=async e=>{e.preventDefault();const r=await fetch('/auth/login',{method:'POST',body:new URLSearchParams(new FormData(e.target))});if(!r.ok){document.getElementById('error').textContent='Check the synthetic credentials';return;}const data=await r.json();localStorage.setItem('demo_access_token',data.access);sessionStorage.setItem('demo_session_token',data.session);const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('demo-auth',1);request.onupgradeneeded=()=>request.result.createObjectStore('tokens');request.onsuccess=()=>resolve(request.result);request.onerror=reject;});await new Promise((resolve,reject)=>{const tx=db.transaction('tokens','readwrite');tx.objectStore('tokens').put(data.indexed,'access');tx.oncomplete=resolve;tx.onerror=reject;});db.close();location.assign('/auth/check');};</script></html>`,
        );
        return true;
      }
      if (u.pathname === "/auth/login" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 4096) {
            res.writeHead(413).end();
            return true;
          }
        }
        const form = new URLSearchParams(body);
        if (
          form.get("user") !== "demo" ||
          form.get("password") !== "demo-password" ||
          form.get("otp") !== "123456"
        ) {
          json(res, { error: "Invalid demo login" }, 401);
          return true;
        }
        const sid = randomBytes(24).toString("hex"),
          state = {
            access: randomBytes(24).toString("hex"),
            session: randomBytes(24).toString("hex"),
            indexed: randomBytes(24).toString("hex"),
          };
        sessions.set(sid, state);
        res.setHeader(
          "Set-Cookie",
          `wf_demo_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        json(res, state);
        return true;
      }
      const sid = cookie(req),
        state = sid ? sessions.get(sid) : undefined;
      if (!state) {
        if (u.pathname.startsWith("/auth/api/") || u.pathname === "/auth/proof")
          json(res, { error: "Authentication required" }, 401);
        else res.writeHead(302, { Location: "/auth/login" }).end();
        return true;
      }
      if (u.pathname === "/auth/proof") {
        const valid =
          req.headers["x-demo-access"] === state.access &&
          req.headers["x-demo-session"] === state.session &&
          req.headers["x-demo-indexed"] === state.indexed;
        json(res, { authenticated: valid }, valid ? 200 : 401);
        return true;
      }
      if (u.pathname === "/auth/check") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authenticated demo account</title><button data-testid="auth-ready" hidden>Authenticated demo account</button><p data-testid="auth-secret">${sid}</p><script>${proofScript}storageProof().then(headers=>fetch('/auth/proof',{headers})).then(async r=>{if(r.ok)document.querySelector('[data-testid="auth-ready"]').hidden=false;else location.assign('/auth/login');});</script></html>`,
        );
        return true;
      }
      if (u.pathname === "/auth/refresh" && req.method === "POST") {
        refreshes++;
        const renewed = randomBytes(24).toString("hex");
        sessions.delete(sid!);
        sessions.set(renewed, state);
        res.setHeader(
          "Set-Cookie",
          `wf_demo_sid=${renewed}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        json(res, { ok: true });
        return true;
      }
      if (u.pathname === "/auth/refresh-on-view") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<p data-testid="refresh-done" hidden>Refreshed</p><script>fetch("/auth/refresh",{method:"POST"}).then(r=>{if(r.ok)document.querySelector("[data-testid=refresh-done]").hidden=false;});</script>',
        );
        return true;
      }
      if (u.pathname === "/auth/api/ticket") {
        const key = u.searchParams.get("id") ?? "";
        json(res, Object.hasOwn(tickets, key) ? tickets[key] : null);
        return true;
      }
      if (u.pathname === "/auth/api/create" && req.method === "POST") {
        writes++;
        json(res, { id: `AUTH-CREATED-${writes}` });
        return true;
      }
      if (u.pathname === "/auth/create") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<label>Summary<input id="summary"></label><button id="create">Create authenticated ticket</button><p data-testid="created-id" hidden></p><script>document.getElementById("create").onclick=async()=>{const r=await fetch("/auth/api/create",{method:"POST"});if(r.ok){const output=document.querySelector("[data-testid=created-id]");output.textContent=(await r.json()).id;output.hidden=false;}};</script>',
        );
        return true;
      }
      if (u.pathname === "/auth/tickets") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authenticated tickets</title><h1>Private synthetic CRM</h1><label for="ticket">Ticket ID</label><input id="ticket"><button id="search">Search</button><section data-testid="ticket-results" hidden></section><script>document.getElementById('search').onclick=async()=>{const data=await(await fetch('/auth/api/ticket?id='+encodeURIComponent(document.getElementById('ticket').value))).json();const result=document.querySelector('[data-testid="ticket-results"]');result.replaceChildren();if(data){for(const [id,text] of [['ticket-found','Ticket found'],['ticket-status',data.status],['ticket-summary',data.summary]]){const p=document.createElement('p');p.dataset.testid=id;p.textContent=text;result.append(p);}}else result.textContent='No matching ticket';result.hidden=false;};</script></html>`,
        );
        return true;
      }
      res.writeHead(404).end();
      return true;
    },
  };
}
