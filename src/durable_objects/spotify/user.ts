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
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS added_tracks (
				id INT AUTO INCREMENT PRIMARY KEY,
				uri VARCHAR(255) NOT NULL,
				poster_id VARCHAR(255) NOT NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			);
			`);
	}

	async initialize(profile: UserProfile, tokenResult: AccessToken) {
		this.setConfig('id', profile.id);
		this.setConfig('profileJSON', JSON.stringify(profile));
		this.setConfig('tokenResultJSON', JSON.stringify(tokenResult));
		this.setConfig('resetToken', tokenResult.refresh_token);
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

	async getAccessToken() {
		const { updated_at } = this.sql.exec(`SELECT updated_at FROM config WHERE config_key=?`, 'tokenResultJSON').one();
		const tokenResultJSON = this.getConfig('tokenResultJSON') as string;
		let tokenResult: AccessToken = JSON.parse(tokenResultJSON);
		const updatedDate = new Date(updated_at as string);
		const expirationTime = updatedDate.getTime() + tokenResult.expires_in * 1000;
		const needsRefresh = Date.now() >= expirationTime;
		if (needsRefresh) {
			tokenResult = await this.refreshToken();
		}
		return tokenResult;
	}

	async refreshToken(): Promise<AccessToken> {
		console.log('Refreshing token');
		const refreshToken = this.getConfig("refreshToken") as string;
		const creds = this.env.SPOTIFY_CLIENT_ID + ':' + this.env.SPOTIFY_CLIENT_SECRET;
		const form = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: this.env.SPOTIFY_CLIENT_ID,
		});
		const response = await fetch('https://accounts.spotify.com/api/token', {
			headers: {
				Authorization: `Basic ${btoa(creds)}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			method: 'POST',
			body: form.toString(),
		});
		const updatedTokenResult: AccessToken = await response.json();
		console.log({updatedTokenResult});
		this.setConfig('tokenResultsJSON', JSON.stringify(updatedTokenResult));
		return updatedTokenResult;
	}

	async getSdk(): Promise<SpotifyApi> {
		const accessToken: AccessToken = await this.getAccessToken();
		// TODO: refresh...it has expires_at, check time last updated, and refresh if needed
		const sdk = SpotifyApi.withAccessToken(this.env.SPOTIFY_CLIENT_ID, accessToken);
		return sdk;
	}

	// NOTE: Not slug
	async createPlaylistFromPosterId(posterIdString: string, trackUris: string[]) {
		const sdk = await this.getSdk();
		const userId = this.getConfig('id') as string;
		const id = this.env.POSTER_AGENT.idFromString(posterIdString);
		const poster = this.env.POSTER_AGENT.get(id);
		// TODO: Use the URL to get the image and then resize it...IMAGES binding?
		const posterUrl = await poster.getConfig('posterUrl');
		const tourName = await poster.getConfig('tourName');
		const playlist = await sdk.playlists.createPlaylist(userId, {
			name: `Band Aid / ${tourName}`,
			description: `A Band Aid Playlist for ${tourName}`,
			collaborative: true,
			public: true,
		});
		await sdk.playlists.addItemsToPlaylist(playlist.id, trackUris);
		trackUris.forEach((uri) => {
			this.sql.exec(`INSERT INTO added_tracks (uri, poster_id) VALUES (?, ?)`, uri, posterIdString);
		});
		return playlist;
	}
}
