import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

// @ts-ignore
import { Buffer } from 'node:buffer';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod.mjs';
import { z } from 'zod';

import { Playlister } from './workflows/playlister';
import { SpotifyUser } from './durable_objects/spotify/user';
import { Layout } from './components/layout';
import { html } from 'hono/html';
import { setCookie } from 'hono/cookie';
import { UserProfile } from '@spotify/web-api-ts-sdk';

export { Playlister, SpotifyUser };

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
	c.setRenderer(Layout(c));
	await next();
});

const EventSchema = z.object({
	venue: z.string({ description: 'The name of the venue where the event is happening' }),
	location: z.string({ description: 'The name of the city where this is happening' }),
	date: z.string({ description: 'The date and time when this is happening in ISO 9601 format' }),
	isUpcoming: z.boolean({ description: 'Have all concert dates not yet happened, or is this a folder from the past' }),
});

// TODO: Maybe: Tour name?
const PosterMetadataSchema = z.object({
	// Often there are numerous bands
	bandNames: z.array(z.string()),
	// There can be multiple places on a poster
	events: z.array(EventSchema),
	slug: z.string({ description: 'A suggested URL safe slug for this event, based on headlining band, location, and the year' }),
});

export type PosterMetadata = z.infer<typeof PosterMetadataSchema>;

export class PosterAgent extends DurableObject<Env> {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// The Config table
		this.sql
			.exec(
				`
			CREATE TABLE IF NOT EXISTS config (
  				config_key VARCHAR(255) NOT NULL,
				config_value TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (config_key)
			);`
			)
			.raw();
		// Status updates
		this.sql
			.exec(
				`
			CREATE TABLE IF NOT EXISTS status_updates (
				id INT AUTO_INCREMENT PRIMARY KEY,
				status TEXT NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`
			)
			.raw();
		// Events Table
		this.sql
			.exec(
				`
			CREATE TABLE IF NOT EXISTS events (
				id INT AUTO_INCREMENT PRIMARY KEY,
				date DATE NULL,
				location VARCHAR(255) NULL,
				venue VARCHAR(255) NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);`
			)
			.raw();
		// Bands Table
		this.sql
			.exec(
				`
			CREATE TABLE IF NOT EXISTS bands (
				id INT AUTO_INCREMENT PRIMARY KEY,
				name VARCHAR(255) NULL,
				description TEXT NULL,
				genre VARCHAR(255) NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);`
			)
			.raw();
		// Links Table
		this.sql
			.exec(
				`
			CREATE TABLE IF NOT EXISTS links (
				id INT AUTO_INCREMENT PRIMARY KEY,
				url TEXT NULL,
				title VARCHAR(255) NULL,
				summary TEXT NULL,
				band_id INT NULL,
				event_id INT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);`
			)
			.raw();
	}

	// Get it? Like tearDown the poster
	async tearDown() {
		// Goodnight sweet prince
		await this.ctx.storage.deleteAll();
		//this.ctx.abort();
	}

	setConfig(key: string, value: string) {
		this.sql
			.exec(
				`INSERT INTO config (config_key, config_value, created_at, updated_at)
			VALUES (
			?,
			?,
			CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP
			)
			ON CONFLICT (config_key) DO UPDATE
			SET
			config_value = excluded.config_value,
			updated_at = CURRENT_TIMESTAMP;`,
				key,
				value
			)
			.raw();
	}

	getConfig(key: string): string | undefined {
		const { value } = this.sql.exec(`SELECT config_value FROM config WHERE config_key=?`, key).next();
		if (!value) return;
		return value.config_value as string;
	}

	getPublicPosterUrl(): string {
		const key = this.getConfig('posterKey');
		return `${this.env.PUBLIC_POSTER_HOST}/${key}`;
	}

	fetch(request: Request): Response | Promise<Response> {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		this.ctx.acceptWebSocket(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async addStatusUpdate(status: string) {
		this.sql.exec(`INSERT INTO status_updates (status) VALUES (?);`, status).next();
		this.broadcastStatus(status);
	}

	async broadcastStatus(status: string) {
		for (const socket of this.ctx.getWebSockets()) {
			socket.send(
				JSON.stringify({
					event: 'status.update',
					posterSlug: this.getConfig('slug'),
					status,
				})
			);
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const msg = JSON.parse(message as string);
		switch (msg.event) {
			case 'status.history.request':
				console.log('status.history.request');
				const results = this.sql.exec(`SELECT status FROM status_updates ORDER BY created_at`).toArray();
				console.log({ results });
				const status_updates = results.map((r) => r.status);
				ws.send(
					JSON.stringify({
						event: 'status.history',
						history: status_updates,
					})
				);
				break;
			default:
				break;
		}
	}

	async initialize(key: string, posterMetadata: PosterMetadata) {
		posterMetadata.events.forEach((event) => {
			this.sql.exec(`INSERT INTO events (date, location, venue) VALUES (?, ?, ?);`, event.date, event.location, event.venue).raw();
		});
		posterMetadata.bandNames.forEach((bandName) => {
			this.sql.exec(`INSERT INTO bands (name) VALUES (?);`, bandName).raw();
		});
		this.setConfig('posterKey', key);
		this.setConfig('metadataJSON', JSON.stringify(posterMetadata));
		this.setConfig('slug', posterMetadata.slug);
		// Create the Playlist...call onSpotifyPlaylistCreated()
		// Add logs table

		await this.env.PLAYLISTER.create({
			params: {
				posterSlug: posterMetadata.slug,
			},
		});
	}
}

app.get('/test', async (c) => {
	return c.render('<h1>Hi mom</h1>');
});

app.get('/kill-em-all', async (c) => {
	const entries = await c.env.POSTER_SLUG_TO_FILE.list();
	for (const key of entries.keys) {
		const id = c.env.POSTER_AGENT.idFromName(key.name);
		const stub = c.env.POSTER_AGENT.get(id);
		await stub.tearDown();
		await c.env.POSTER_SLUG_TO_FILE.delete(key.name);
	}
	return c.json({ success: true });
});

app.get('/', async (c) => {
	const entries = await c.env.POSTER_SLUG_TO_FILE.list();
	let linksHTML = '<ul>';
	for (const key of entries.keys) {
		const id = c.env.POSTER_AGENT.idFromName(key.name);
		const stub = c.env.POSTER_AGENT.get(id);
		const posterUrl = await stub.getPublicPosterUrl();
		linksHTML += html`<li>
			<a href="/posters/${key.name}"><img src="${posterUrl}" /></a>
		</li>`;
	}
	linksHTML += '</ul>';
	return c.render(linksHTML);
});

app.get('/spotify/login', async (c) => {
	const state = crypto.randomUUID();
	const scope = 'playlist-read-collaborative playlist-modify-public';
	const url = new URL(c.req.url);
	url.pathname = '/spotify/callback';

	const qs = new URLSearchParams({
		response_type: 'code',
		client_id: c.env.SPOTIFY_CLIENT_ID,
		redirect_uri: url.toString(),
		state,
		scope,
	});
	return c.redirect(`https://accounts.spotify.com/authorize?${qs.toString()}`);
});

app.get('/spotify/callback', async (c) => {
	const { code, state } = c.req.query();
	// TODO: State good?
	const creds = c.env.SPOTIFY_CLIENT_ID + ':' + c.env.SPOTIFY_CLIENT_SECRET;
	const url = new URL(c.req.url);
	url.search = '';
	console.log('redirect_uri', url.toString());
	const form = new URLSearchParams({
		code,
		redirect_uri: url.toString(),
		grant_type: 'authorization_code',
	});
	const response = await fetch('https://accounts.spotify.com/api/token', {
		headers: {
			Authorization: `Basic ${btoa(creds)}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		method: 'POST',
		body: form.toString(),
	});
	const tokenResult: { access_token: string; refresh_token: string } = await response.json();
	console.log(tokenResult);
	// Grab the userid (use the SDK?)
	const profileResponse = await fetch('https://api.spotify.com/v1/me', {
		headers: {
			Authorization: `Bearer ${tokenResult.access_token}`,
		},
	});
	const profile: UserProfile = await profileResponse.json();
	const id = c.env.SPOTIFY_USER.idFromName(profile.id);
	const stub = c.env.SPOTIFY_USER.get(id);
	stub.initialize(profile, tokenResult.access_token, tokenResult.refresh_token);
	setCookie(c, 'spotifyUserId', profile.id);
	setCookie(c, 'spotifyAccessToken', tokenResult.access_token);
	return c.redirect("/");
});

app.get('/posters/:slug', async (c) => {
	const { slug } = c.req.param();
	if (!slugExists(c.env, slug)) {
		return c.notFound();
	}
	return c.render(html`
		<div class="poster-container">
			<h1 class="poster-header">Band Poster</h1>
			<img src="" alt="Band Poster" class="poster-image" id="posterImage" />
			<div class="events-list" id="eventsList"></div>
		</div>
	`);
});

app.get('/api/posters/:slug/ws', async (c) => {
	const { slug } = c.req.param();
	if (!slugExists(c.env, slug)) {
		return c.notFound();
	}
	const id = c.env.POSTER_AGENT.idFromName(slug);
	const stub = c.env.POSTER_AGENT.get(id);
	return stub.fetch(c.req.raw);
});

app.get('/api/posters/:slug', async (c) => {
	const { slug } = c.req.param();
	if (!slugExists(c.env, slug)) {
		return c.notFound();
	}
	const id = c.env.POSTER_AGENT.idFromName(slug);
	const stub = c.env.POSTER_AGENT.get(id);
	return c.json({
		imageUrl: await stub.getPublicPosterUrl(),
	});
});

app.get('/api/posters', async (c) => {
	// TODO: Implement paging
	// TODO: Get Keys/Poster
	const uploads = await c.env.BAND_AID.list();
	return c.json({ results: ['TODO: Return key and poster'] });
});

function slugExists(env: Env, slug: string) {
	const result = env.POSTER_SLUG_TO_FILE.get(slug);
	return result !== null;
}

async function extractPosterMetadata(env: Env, key: string): Promise<PosterMetadata | undefined> {
	const fileUpload = await env.BAND_AID.get(key);
	if (fileUpload === null) {
		return;
	}
	const contentType = fileUpload.httpMetadata?.contentType;
	const aBuffer = await fileUpload.arrayBuffer();
	const base64String = Buffer.from(aBuffer).toString('base64');
	const oai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
	const completion = await oai.beta.chat.completions.parse({
		model: 'gpt-4o',
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: `Extract the information from this concert poster. The current date is ${new Date()}` },
					{ type: 'image_url', image_url: { url: `data:${contentType};base64,${base64String}` } },
				],
			},
		],
		response_format: zodResponseFormat(PosterMetadataSchema, 'poster'),
	});
	const poster = completion.choices[0].message.parsed;
	if (poster === null) {
		return;
	}
	return poster;
}

export default {
	fetch: app.fetch,
	async queue(batch: MessageBatch<{ action: string; object: { key: string } }>, env: Env) {
		for (const msg of batch.messages) {
			const payload = msg.body;
			const key: string = payload.object.key as string;
			switch (payload.action) {
				case 'PutObject':
					console.log('Extracting poster for file', key);
					const posterMetadata = await extractPosterMetadata(env, key);
					if (!posterMetadata) {
						console.warn(`Did not receive posterMetadata for ${key}`);
						continue;
					}
					console.log({ posterMetadataJSON: JSON.stringify(posterMetadata) });
					if (posterMetadata.slug) {
						// ???: Should we allow for duplicate slug names? Current answer NO
						const match = await env.POSTER_SLUG_TO_FILE.get(posterMetadata.slug);
						if (match) {
							console.warn('Existing slug found for file', posterMetadata.slug, key);
							continue;
						}
						await env.POSTER_SLUG_TO_FILE.put(posterMetadata.slug, key);
						const agentId = env.POSTER_AGENT.idFromName(posterMetadata.slug);
						const stub = env.POSTER_AGENT.get(agentId);
						await stub.initialize(key, posterMetadata);
					}
					break;
				default:
					console.log(`Unhandled action ${payload.action}`, payload);
					break;
			}
			msg.ack();
		}
	},
};
