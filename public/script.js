// Helper function to extract the slug from the URL.
// If URL is something like https://example.com/posters/SLUG
// we can parse the last part of the path.
function getSlug() {
	const path = window.location.pathname;
	// We expect the path to be something like /posters/SLUG
	// so split on '/' and take the last segment.
	const parts = path.split("/").filter(Boolean);
	return parts[1] || ""; // parts[0] should be "posters", parts[1] is the slug.
  }

  const slug = getSlug();

  // Endpoint to get poster data.
  const apiUrl = `/api/posters/${slug}`;

  // Determine ws or wss based on current page.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/posters/${slug}/ws`;

  // Fetch poster data and update the UI.
  async function fetchPosterData() {
	try {
	  const response = await fetch(apiUrl);
	  if (!response.ok) {
		throw new Error("Failed to fetch poster data.");
	  }
	  const data = await response.json();
	  const imageUrl = data.imageUrl;
	  // Update the poster image.
	  document.getElementById("posterImage").src = imageUrl;
	} catch (error) {
	  console.error("Error fetching poster data:", error);
	}
  }

  // Initialize the WebSocket connection and listen for events.
  function initWebSocket() {
	const socket = new WebSocket(wsUrl);

	socket.addEventListener("open", () => {
	  console.log("WebSocket connection established.");
	  // Get the history up until now.
	  socket.send(JSON.stringify({event: "status.history.request"}));

	});

	socket.addEventListener("message", (event) => {
	  const payload = JSON.parse(event.data);
	  switch(payload.event) {
		case "status.update":
			addStatus(payload.status);
			break;
		case "status.history":
			payload.history.forEach(addStatus);
			break
	  }
	});

	socket.addEventListener("close", () => {
	  console.log("WebSocket connection closed.");
	});

	socket.addEventListener("error", (err) => {
	  console.error("WebSocket error:", err);
	});
  }

  // Display an event object in the events list.
  function addStatus(status) {
	const eventsList = document.getElementById("eventsList");
	const eventItem = document.createElement("div");
	eventItem.className = "event-item";
	eventItem.innerText = status;
	eventsList.prepend(eventItem); // place the newest on top
  }

  // Run our initialization.
  fetchPosterData();
  initWebSocket();
