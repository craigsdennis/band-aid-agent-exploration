import { DurableObject } from 'cloudflare:workers';
import { AccessToken, SpotifyApi, UserProfile } from '@spotify/web-api-ts-sdk';

export class SpotifyUser extends DurableObject<Env> {
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
	}

	async initialize(profile: UserProfile, tokenResult: AccessToken) {
		this.setConfig('id', profile.id);
		this.setConfig('profileJSON', JSON.stringify(profile));
		this.setConfig('tokenResultJSON', JSON.stringify(tokenResult));
	}

	getAllConfig() {
		const rows = this.sql.exec(`SELECT config_key, config_value FROM config ORDER BY config_key`).toArray();
		const config = {};
		for (const row of rows) {
			const key = row.config_key as string;
			const value = row.config_value as string;
			// @ts-ignore - Yuck
			config[key] = value;
		}
		return config;
	}

	async tearDown() {
		// Goodnight sweet prince
		this.ctx.storage.deleteAll();
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

	getSdk(): SpotifyApi {
		const tokenResultJSON = this.getConfig("tokenResultJSON");
		const accessToken: AccessToken = JSON.parse(tokenResultJSON as string);
		// Not sure refresh will work (TODO: I don't think it does automatically, do some stuff here to make sure it's good)
		return SpotifyApi.withAccessToken(this.env.SPOTIFY_CLIENT_ID, accessToken);
	}

	// NOTE: Not slug
	async createPlaylistFromPosterId(posterIdString: string, trackUris: string[]) {
		const sdk = this.getSdk();
		const userId = this.getConfig("id") as string;
		const id = this.env.POSTER_AGENT.idFromString(posterIdString);
		const poster = this.env.POSTER_AGENT.get(id);
		// TODO: Use the URL to get the image and then resize it...IMAGES binding?
		const posterUrl = await poster.getConfig("posterUrl");
		const tourName = await poster.getConfig("tourName");
		const playlist = await sdk.playlists.createPlaylist(userId, {
			name: `Band Aid / ${tourName}`,
			description: `A Band Aid Playlist for ${tourName}`,
			collaborative: true,
			public: true
		});
		await sdk.playlists.addItemsToPlaylist(playlist.id, trackUris);
		return playlist;
	}
}
