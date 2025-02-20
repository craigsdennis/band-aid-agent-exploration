import { Hono } from 'hono';

import { Playlister } from './workflows/playlister';
import { SpotifyUser } from './durable_objects/spotify/user';
import { PosterAgent } from './durable_objects/poster_agent';
import { Orchestrator } from './durable_objects/orchestrator';
import { Layout } from './components/layout';
import { html } from 'hono/html';
import { setCookie } from 'hono/cookie';
import { AccessToken, UserProfile } from '@spotify/web-api-ts-sdk';

export { Playlister, SpotifyUser, PosterAgent, Orchestrator };

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
	c.setRenderer(Layout(c));
	await next();
});

app.get('/test', async (c) => {
	return c.render('<h1>Hi mom</h1>');
});

app.get('/remove-all-posters', async (c) => {
	const orchestrator = getOrchestrator(c.env);
	await orchestrator.deleteAllPosters();
	return c.json({ success: true });
});

function getOrchestrator(env: Env) {
	const orchestratorId = env.ORCHESTRATOR.idFromName("main");
	return env.ORCHESTRATOR.get(orchestratorId);
}

async function getPosterFromSlug(env: Env, slug: string) {
	const orchestrator = getOrchestrator(env);
	// TODO: handle non-existent
	const posterIdString = await orchestrator.getPosterIdFromSlug(slug) as string;
	const posterId = env.POSTER_AGENT.idFromString(posterIdString);
	return env.POSTER_AGENT.get(posterId);
}

app.get('/', async (c) => {
	const orchestrator = getOrchestrator(c.env);
	const posters = await orchestrator.getPosters();
	let linksHTML = '<ul>';
	for (const poster of posters) {
		linksHTML += html`<li>
			<a href="/posters/${poster.slug}"><img src="${poster.posterUrl}" /></a>
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
	const tokenResult: AccessToken = await response.json();
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
	await stub.initialize(profile, tokenResult);
	setCookie(c, 'spotifyUserId', profile.id);
	setCookie(c, 'spotifyAccessToken', tokenResult.access_token);
	return c.redirect("/");
});

app.get("/spotify/reset/:userId", async(c) => {
	const {userId} = c.req.param();
	const id = c.env.SPOTIFY_USER.idFromName(userId);
	const spotifyUser = c.env.SPOTIFY_USER.get(id);
	await spotifyUser.tearDown();
	return c.json({success: true, userId});
});

app.get("/spotify/debug/:userId", async(c) => {
	const {userId} = c.req.param();
	const id = c.env.SPOTIFY_USER.idFromName(userId);
	const spotifyUser = c.env.SPOTIFY_USER.get(id);
	const token = await spotifyUser.getAccessToken();
	return c.json({success: true, token, userId});
});

app.get('/posters/:slug', async (c) => {
	const { slug } = c.req.param();
	const posterStub = await getPosterFromSlug(c.env, slug);
	// Double check
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
	const posterStub = await getPosterFromSlug(c.env, slug);
	return posterStub.fetch(c.req.raw);
});

app.get('/api/posters/:slug', async (c) => {
	const { slug } = c.req.param();
	const posterStub = await getPosterFromSlug(c.env, slug);
	return c.json({
		imageUrl: await posterStub.getPublicPosterUrl(),
	});
});

app.get('/api/posters', async (c) => {
	// TODO: Implement paging
	// TODO: Get Keys/Poster
	const uploads = await c.env.BAND_AID.list();
	return c.json({ results: ['TODO: Return key and poster'] });
});

export default {
	fetch: app.fetch,
	async queue(batch: MessageBatch<{ action: string; object: { key: string } }>, env: Env) {
		for (const msg of batch.messages) {
			const payload = msg.body;
			const key: string = payload.object.key as string;
			switch (payload.action) {
				case 'PutObject':
					console.log('Adding Poster for key', key);
					const orchestratorId = env.ORCHESTRATOR.idFromName("main");
					const orchestrator = env.ORCHESTRATOR.get(orchestratorId);
					await orchestrator.submitPoster(`r2://${key}`);
				default:
					console.log(`Unhandled action ${payload.action}`, payload);
					break;
			}
			msg.ack();
		}
	},
};
