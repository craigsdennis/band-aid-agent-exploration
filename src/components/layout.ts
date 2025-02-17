import { Context } from 'hono';
import { html } from 'hono/html';

export const Layout = (c: Context) => (content: string | Promise<string>) => {
	return c.html(`<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Band Poster Page</title>
				<!-- External CSS -->
				<link rel="stylesheet" href="/styles.css" />
			</head>
			<body>
				${content}
				<!-- External JavaScript -->
				<script src="/script.js"></script>
				<footer>
					<p>Built with 🧡 using Durable Objects</p>
				</footer>
			</body>
		</html>`);
};
