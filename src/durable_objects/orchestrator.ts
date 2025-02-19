import { DurableObject } from 'cloudflare:workers';

export class Orchestrator extends DurableObject<Env> {
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
		this.sql
			.exec(
				`
			CREATE TABLE IF NOT EXISTS poster_submissions (
				id TEXT PRIMARY KEY,
				url TEXT NOT NULL,
				slug TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`
			)
			.raw();
	}

	async deleteAllPosters() {
		const submissions = this.sql.exec(`SELECT * FROM poster_submissions ORDER BY created_at DESC`).toArray();
		for (const sub of submissions) {
			const posterAgentId = this.env.POSTER_AGENT.idFromString(sub.id as string);
			const posterAgent = this.env.POSTER_AGENT.get(posterAgentId);
			console.log('Deleting posterAgent', sub.slug);
			await posterAgent.tearDown();
		}
		this.sql.exec(`DELETE FROM poster_submissions`).raw();
	}

	async getPosters() {
		const submissions = this.sql.exec(`SELECT * FROM poster_submissions ORDER BY created_at DESC`).toArray();
		console.log({ submissions });
		const posterPromises = submissions.map(async (submission) => {
			const posterId = this.env.POSTER_AGENT.idFromString(submission.id as string);
			const posterStub = this.env.POSTER_AGENT.get(posterId);
			return {
				slug: submission.slug,
				posterUrl: await posterStub.getPublicPosterUrl(),
			};
		});
		// This right?
		const posters = await Promise.all(posterPromises);
		return posters;
	}

	async getPosterIdFromSlug(slug: string): Promise<string> {
		const { id } = this.sql.exec(`SELECT id FROM poster_submissions WHERE slug=? LIMIT 1;`, slug).one();
		return id;
	}

	async submitPoster(url: string) {
		// INSERT submission
		const id = this.env.POSTER_AGENT.newUniqueId();
		this.sql.exec(`INSERT INTO poster_submissions (id, url) VALUES (?, ?) RETURNING id`, id.toString(), url).one();
		const stub = this.env.POSTER_AGENT.get(id);
		await stub.initialize(url);
		// Update slug
		const slug = await stub.getConfig('slug');
		this.sql.exec(`UPDATE poster_submissions SET slug=? WHERE id=?`, slug, id);
		return { success: true };
	}
}
