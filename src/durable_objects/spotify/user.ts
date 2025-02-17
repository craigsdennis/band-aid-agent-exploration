import { DurableObject } from 'cloudflare:workers';
import { SpotifyApi, UserProfile } from '@spotify/web-api-ts-sdk';

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

	async initialize(profile: UserProfile, accessToken: string, refreshToken: string) {
		this.setConfig('profileJSON', JSON.stringify(profile));
		this.setConfig('accessToken', accessToken);
		this.setConfig('refreshToken', refreshToken);
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

	// Memoize Spotify client?
	// Refresh
}
