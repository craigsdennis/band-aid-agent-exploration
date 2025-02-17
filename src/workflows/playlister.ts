import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export type Params = {
	posterSlug: string;
}

export class Playlister extends WorkflowEntrypoint<Env, Params> {

	getAgent(posterSlug: string) {
		const id = this.env.POSTER_AGENT.idFromName(posterSlug);
		return this.env.POSTER_AGENT.get(id);
	}

	getSpotifyClient() {
		return SpotifyApi.withClientCredentials(
			this.env.SPOTIFY_CLIENT_ID,
			this.env.SPOTIFY_CLIENT_SECRET
		);
	}

	async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<string> {
		// TODO: Extract band names
		// TODO: Loop
		const spotifyArtistId = await step.do("Find Spotify band id", async () => {
			const agent = this.getAgent(event.payload.posterSlug);
			agent.addStatusUpdate(`Searching Spotify for ${event.payload.bandName}`);
			const spotifyApi = this.getSpotifyClient();
			const results = await spotifyApi.search(event.payload.bandName, ["artist"]);
			const id = results.artists.items.at(0)?.id;
			return id;
		});
		if (spotifyArtistId) {
			// TODO: https://developer.spotify.com/documentation/web-api/reference/get-an-artists-top-tracks
			const songIds = await step.do(`Find top 3 songs for ${event.payload.bandName}`, async () => {
				const spotifyApi = this.getSpotifyClient();
				const results = await spotifyApi.artists.topTracks(spotifyArtistId, "US");
				return results.tracks.map(t => t.id);
			});

		}

		return "done";
	}

};
