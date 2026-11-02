self.addEventListener("push", (event) => {
	const data = event.data?.json() ?? {};
	event.waitUntil(
		self.registration.showNotification(data.title ?? "Telekom Störungsmelder", {
			body: data.body,
			tag: data.tag,
			icon: "/icon.svg",
			data: { url: data.url ?? "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = event.notification.data?.url ?? "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
			const client = clients.find((c) => c.url === url) ?? clients[0];
			return client ? client.navigate(url).then((c) => (c ?? client).focus()) : self.clients.openWindow(url);
		}),
	);
});
