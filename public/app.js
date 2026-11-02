const $ = (id) => document.getElementById(id);

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" });
const percent = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 2 });

let currentLine = null;

function duration(ms) {
	if (ms == null) return "–";
	const minutes = Math.round(ms / 60000);
	if (minutes < 60) return `${minutes} Min.`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} Std. ${minutes % 60} Min.`;
	return `${Math.floor(hours / 24)} T. ${hours % 24} Std.`;
}

function el(tag, attrs = {}, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	node.append(...children.filter((c) => c != null));
	return node;
}

function flash(message) {
	$("flash").textContent = message;
	$("flash").hidden = !message;
}

async function api(path, options = {}) {
	const res = await fetch(`/api${path}`, {
		...options,
		headers: options.body ? { "Content-Type": "application/json" } : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

// --- Line entry -----------------------------------------------------------

$("line-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const button = e.target.querySelector("button");
	button.disabled = true;
	try {
		const { id } = await api("/lines", {
			method: "POST",
			body: JSON.stringify({ areaCode: $("area-code").value, number: $("number").value }),
		});
		localStorage.setItem("lastLine", id);
		history.pushState(null, "", `/?line=${encodeURIComponent(id)}`);
		flash("");
		await showLine(id);
	} catch (err) {
		flash(err.message);
	} finally {
		button.disabled = false;
	}
});

$("change-line").addEventListener("click", () => {
	history.pushState(null, "", "/");
	showSearch();
});

window.addEventListener("popstate", route);

function showSearch() {
	currentLine = null;
	$("result").hidden = true;
	$("search").hidden = false;
	$("area-code").focus();
}

// --- Status ---------------------------------------------------------------

async function showLine(id) {
	$("search").hidden = true;
	$("result").hidden = false;
	$("status").replaceChildren(el("p", { class: "muted" }, "Prüfe bei der Telekom …"));
	$("status-meta").textContent = "";
	let data;
	try {
		data = await api(`/lines/${encodeURIComponent(id)}`);
	} catch (err) {
		flash(err.message);
		showSearch();
		return;
	}
	currentLine = data.line;
	const label = `${data.line.areaCode} / ${data.line.number}`;
	$("line-label").textContent = label;
	document.title = `${label} – Telekom Störungsmelder`;
	$("status-meta").textContent =
		(data.checkedAt ? `Stand: ${dateTime.format(data.checkedAt)}` : "Noch nicht geprüft") + (data.checkError ? ` – ${data.checkError}` : "");
	$("status").replaceChildren(
		...(data.faults.length
			? data.faults.map((f) =>
					el(
						"div",
						{ class: "fault" },
						el("h3", {}, "Flächenstörung"),
						el("p", {}, f.text),
						el("p", { class: "muted small" }, `bekannt seit ${dateTime.format(f.firstSeen)}`),
					),
				)
			: data.checkedAt
				? [el("p", { class: "status-ok" }, "Keine Flächenstörung für diesen Anschluss bekannt.")]
				: []),
	);
	$("national-open").replaceChildren(...data.national.map(nationalCard));
	await Promise.all([loadStats(id), loadNational(), refreshPushState()]);
	$("email-state").textContent = "";
}

// --- Nationwide (telekom.com Störungsübersicht) -----------------------------

function nationalCard(n) {
	return el(
		"div",
		{ class: "fault national" },
		el("h3", {}, `Bundesweite Störung: ${n.service}`),
		el("p", {}, n.description),
		el("p", { class: "muted small" }, `seit ${dateTime.format(n.firstSeen)} · Quelle: Störungsübersicht der Telekom`),
	);
}

async function loadNational() {
	const { incidents } = await api("/national");
	$("national-history").replaceChildren(
		el("tr", {}, el("th", {}, "Dienst"), el("th", {}, "Beginn"), el("th", {}, "Ende"), el("th", {}, "Dauer"), el("th", {}, "Meldung")),
		...(incidents.length
			? incidents.map((n) =>
					el(
						"tr",
						{},
						el("td", {}, n.service),
						el("td", {}, dateTime.format(n.firstSeen)),
						el("td", {}, n.resolvedAt ? dateTime.format(n.resolvedAt) : "aktiv"),
						el("td", {}, duration((n.resolvedAt ?? Date.now()) - n.firstSeen)),
						el("td", {}, n.description),
					),
				)
			: [el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Seit Beginn der Beobachtung keine bundesweite Störung gemeldet."))]),
	);
}

// --- Statistics -----------------------------------------------------------

async function loadStats(id) {
	const { stats, history, historyTotal } = await api(`/lines/${encodeURIComponent(id)}/stats`);
	$("stats-meta").textContent = `Beobachtet seit ${dateTime.format(stats.monitoredSince)} · ${stats.checks} Prüfungen${
		stats.errors ? `, ${stats.errors} fehlgeschlagen` : ""
	}`;

	$("stats-windows").replaceChildren(
		...stats.windows
			.filter((w, i) => i === 0 || stats.windows[i - 1].observedMs < w.observedMs)
			.map((w) =>
				el(
					"div",
					{ class: "window" },
					el("div", { class: "muted small" }, `Letzte ${w.days} Tage`),
					el("div", { class: "big" }, w.availability == null ? "–" : percent.format(w.availability)),
					el("div", { class: "muted small" }, "ohne Störung"),
					el(
						"dl",
						{},
						el("dt", {}, "Störungen"),
						el("dd", {}, String(w.incidents)),
						el("dt", {}, "Störungsdauer"),
						el("dd", {}, duration(w.incidentMs)),
						el("dt", {}, "Ø bis behoben"),
						el("dd", {}, duration(w.mttrMs)),
						el("dt", {}, "Längste"),
						el("dd", {}, duration(w.longestMs)),
					),
				),
			),
	);

	const maxDay = Math.max(60, ...stats.daily.map((d) => d.incidentMinutes));
	// Days before monitoring started stay blank instead of looking like days without outages.
	const unobserved = Array.from({ length: 90 - stats.daily.length }, () => el("div", { class: "day", title: "nicht beobachtet" }));
	$("stats-daily").replaceChildren(
		...unobserved,
		...stats.daily.map((d) => {
			const day = el("div", { class: "day observed", title: `${d.date}: ${d.incidentMinutes} Min. Störung` });
			if (d.incidentMinutes > 0) day.append(el("div", { class: "incident", style: `height:${(d.incidentMinutes / maxDay) * 100}%` }));
			return day;
		}),
	);

	renderBars($("stats-hour"), stats.byHour, (i) => `${i}`, (i) => `${i}–${i + 1} Uhr`);
	renderBars($("stats-weekday"), stats.byWeekday, (i) => WEEKDAYS[i], (i) => WEEKDAYS[i]);

	$("history").replaceChildren(
		el("tr", {}, el("th", {}, "Beginn"), el("th", {}, "Ende"), el("th", {}, "Dauer"), el("th", {}, "Meldung")),
		...(history.length
			? history.map((f) =>
					el(
						"tr",
						{},
						el("td", {}, dateTime.format(f.firstSeen)),
						el("td", {}, f.resolvedAt ? dateTime.format(f.resolvedAt) : "aktiv"),
						el("td", {}, duration((f.resolvedAt ?? Date.now()) - f.firstSeen)),
						el("td", {}, f.text),
					),
				)
			: [el("tr", {}, el("td", { colspan: "4", class: "muted" }, "Bisher keine Flächenstörung beobachtet."))]),
		...(historyTotal > history.length
			? [el("tr", {}, el("td", { colspan: "4", class: "muted" }, `… und ${historyTotal - history.length} ältere`))]
			: []),
	);
}

function renderBars(container, values, label, title) {
	const max = Math.max(1, ...values);
	container.replaceChildren(...values.map((v, i) => el("div", { style: `height:${(v / max) * 100}%`, title: `${title(i)}: ${v}` })));
	const labels = el("div", { class: "bar-labels" }, ...values.map((_, i) => el("span", {}, values.length > 12 && i % 3 ? "" : label(i))));
	container.nextElementSibling?.classList.contains("bar-labels") ? container.nextElementSibling.replaceWith(labels) : container.after(labels);
}

// --- Push -----------------------------------------------------------------

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const pushTokens = () => JSON.parse(localStorage.getItem("pushTokens") ?? "{}");
const savePushTokens = (tokens) => localStorage.setItem("pushTokens", JSON.stringify(tokens));

function urlBase64ToUint8Array(base64) {
	const raw = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function refreshPushState() {
	const button = $("push-toggle");
	if (!pushSupported) {
		button.disabled = true;
		$("push-state").textContent = "Dieser Browser unterstützt keine Push-Benachrichtigungen. Auf iOS: Seite zum Home-Bildschirm hinzufügen.";
		return;
	}
	const subscribed = Boolean(pushTokens()[currentLine.id]);
	button.textContent = subscribed ? "Push deaktivieren" : "Push aktivieren";
	button.className = subscribed ? "secondary" : "";
	button.disabled = false;
	$("push-state").textContent =
		Notification.permission === "denied" ? "Benachrichtigungen sind für diese Seite blockiert." : subscribed ? "Aktiv in diesem Browser." : "";
}

$("push-toggle").addEventListener("click", async () => {
	const button = $("push-toggle");
	button.disabled = true;
	const tokens = pushTokens();
	try {
		if (tokens[currentLine.id]) {
			await api("/unsubscribe", { method: "POST", body: JSON.stringify({ token: tokens[currentLine.id] }) });
			delete tokens[currentLine.id];
		} else {
			if ((await Notification.requestPermission()) !== "granted") throw new Error("Benachrichtigungen wurden nicht erlaubt.");
			const registration = await navigator.serviceWorker.register("/sw.js");
			await navigator.serviceWorker.ready;
			const { key } = await api("/vapid-public-key");
			const subscription =
				(await registration.pushManager.getSubscription()) ??
				(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
			const { token } = await api(`/lines/${encodeURIComponent(currentLine.id)}/subscriptions`, {
				method: "POST",
				body: JSON.stringify({ kind: "push", subscription: subscription.toJSON() }),
			});
			tokens[currentLine.id] = token;
		}
		savePushTokens(tokens);
	} catch (err) {
		$("push-state").textContent = err.message;
		button.disabled = false;
		return;
	}
	await refreshPushState();
});

// --- Email ----------------------------------------------------------------

$("email-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const button = e.target.querySelector("button");
	button.disabled = true;
	try {
		await api(`/lines/${encodeURIComponent(currentLine.id)}/subscriptions`, {
			method: "POST",
			body: JSON.stringify({ kind: "email", email: $("email").value }),
		});
		$("email-state").textContent = "Fast geschafft: Bitte bestätige den Link in der E-Mail, die wir Dir geschickt haben.";
		$("email").value = "";
	} catch (err) {
		$("email-state").textContent = err.message;
	} finally {
		button.disabled = false;
	}
});

// --- Routing --------------------------------------------------------------

async function route() {
	flash("");
	const params = new URLSearchParams(location.search);
	try {
		if (params.has("confirm")) {
			const { lineId } = await api("/confirm", { method: "POST", body: JSON.stringify({ token: params.get("confirm") }) });
			history.replaceState(null, "", `/?line=${encodeURIComponent(lineId)}`);
			flash("E-Mail-Benachrichtigungen sind aktiv.");
			return showLine(lineId);
		}
		if (params.has("unsubscribe")) {
			const { lineId } = await api("/unsubscribe", { method: "POST", body: JSON.stringify({ token: params.get("unsubscribe") }) });
			history.replaceState(null, "", lineId ? `/?line=${encodeURIComponent(lineId)}` : "/");
			flash(lineId ? "Du erhältst keine Benachrichtigungen mehr für diesen Anschluss." : "Dieses Abo existiert nicht mehr.");
			return lineId ? showLine(lineId) : showSearch();
		}
	} catch (err) {
		flash(err.message);
	}
	const id = params.get("line") ?? localStorage.getItem("lastLine");
	return id ? showLine(id) : showSearch();
}

route();
