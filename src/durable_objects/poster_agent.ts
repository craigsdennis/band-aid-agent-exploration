import { DurableObject } from 'cloudflare:workers';

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod.mjs';
import { z } from 'zod';

const EventSchema = z.object({
	venue: z.string({ description: 'The name of the venue where the event is happening' }),
	location: z.string({ description: 'The name of the city where this is happening' }),
	date: z.string({ description: 'The date and time when this is happening in ISO 9601 format' }),
	isUpcoming: z.boolean({ description: 'Have all concert dates not yet happened, or is this from the past' }),
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
		// TODO: Delete r2?
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

	getPublicPosterUrl(): string | undefined {
		const url = this.getConfig('posterUrl');
		if (!url) return;
		let publicUrl = url;
		if (url?.startsWith('r2://')) {
			publicUrl = `${this.env.PUBLIC_POSTER_HOST}/${url.replace('r2://', '')}`;
		}
		return publicUrl;
	}

	getBandNames(): string[] {
		const results = this.sql.exec(`SELECT name FROM bands`).toArray();
		return results.map((r) => r.name as string);
	}

	updateBandWithName(name: string, options) {
		const { id } = this.sql.exec(`SELECT id FROM bands WHERE name=?`, name).one();
		if (options.genre) {
			this.sql.exec(`UPDATE bands SET genre=? WHERE id=?`, options.genre, id).raw();
		}
		for (const link of options.links) {
			this.sql.exec(`INSERT INTO links (title, description, url, band_id) VALUES (?, ?, ?, ?)`, link.title, link.description, link.url, id).raw();
		}
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

	async initialize(url: string) {
		let imageUrl = url;
		if (url.startsWith('r2://')) {
			const key = url.replace('r2://', '');
			// BAND_AID is the r2 bucket
			const fileUpload = await this.env.BAND_AID.get(key);
			if (fileUpload === null) {
				return;
			}
			const contentType = fileUpload.httpMetadata?.contentType;
			const aBuffer = await fileUpload.arrayBuffer();
			const base64String = Buffer.from(aBuffer).toString('base64');
			imageUrl = `data:${contentType};base64,${base64String}`;
		}
		const oai = new OpenAI({ apiKey: this.env.OPENAI_API_KEY });
		const completion = await oai.beta.chat.completions.parse({
			model: 'gpt-4o',
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: `Extract the information from this concert poster. The current date is ${new Date()}` },
						{ type: 'image_url', image_url: { url: imageUrl } },
					],
				},
			],
			response_format: zodResponseFormat(PosterMetadataSchema, 'poster'),
		});

		const posterMetadata = completion.choices[0].message.parsed as PosterMetadata;
		posterMetadata.events.forEach((event) => {
			this.sql.exec(`INSERT INTO events (date, location, venue) VALUES (?, ?, ?);`, event.date, event.location, event.venue).raw();
		});
		posterMetadata.bandNames.forEach((bandName) => {
			this.sql.exec(`INSERT INTO bands (name) VALUES (?);`, bandName).raw();
		});
		// NOTE: This keeps the r2:// url
		this.setConfig('posterUrl', url);
		this.setConfig('metadataJSON', JSON.stringify(posterMetadata));
		this.setConfig('slug', posterMetadata.slug);
		// Create the Playlist...call onSpotifyPlaylistCreated()
		await this.env.PLAYLISTER.create({
			params: {
				posterSlug: posterMetadata.slug,
			},
		});
	}
}
