import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export type Params = {
	posterSlug: string;
};

export class Playlister extends WorkflowEntrypoint<Env, Params> {
	getOrchestrator() {
		const id = this.env.ORCHESTRATOR.idFromName('main');
		return this.env.ORCHESTRATOR.get(id);
	}

	async getPosterAgent(posterIdString: string) {
		const id = this.env.POSTER_AGENT.idFromString(posterIdString);
		return this.env.POSTER_AGENT.get(id);
	}

	getSpotifyClient() {
		return SpotifyApi.withClientCredentials(this.env.SPOTIFY_CLIENT_ID, this.env.SPOTIFY_CLIENT_SECRET);
	}

	async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<string> {
		const posterIdString = await step.do('Get Poster ID From Slug', async () => {
			const orchestrator = this.getOrchestrator();
			const posterIdString = await orchestrator.getPosterIdFromSlug(event.payload.posterSlug);
			return posterIdString as string;
		});
		const bandNames = await step.do('Get Band Names', async () => {
			const poster = await this.getPosterAgent(posterIdString);
			const bandNames = await poster.getBandNames();
			return bandNames;
		});
		let trackUris: string[] = [];
		for (const bandName of bandNames) {
			const spotifyArtist = await step.do('Find Spotify Artist', async () => {
				const poster = await this.getPosterAgent(posterIdString);
				poster.addStatusUpdate(`Searching Spotify for Artist: ${bandName}`);
				const spotifyApi = this.getSpotifyClient();
				const results = await spotifyApi.search(bandName, ['artist']);
				// TODO: Handle undefined
				return results.artists.items.at(0);
			});
			if (spotifyArtist) {
				const result = await step.do('Update Band information', async () => {
					const poster = await this.getPosterAgent(posterIdString);
					// TODO: There's a bug here???
					await poster.updateBandWithName(bandName, {
						genre: spotifyArtist.genres.join(', '),
						links: [
							{
								title: `${spotifyArtist.name} on Spotify`,
								description: 'Official Spotify Artist Page',
								url: spotifyArtist.href,
							},
						],
					});
					await poster.addStatusUpdate(`Found Spotify Artist page for ${spotifyArtist.name}: ${spotifyArtist.href}`);
					return {success: true};
				});
				// TODO: https://developer.spotify.com/documentation/web-api/reference/get-an-artists-top-tracks
				trackUris = await step.do(`Find top tracks for ${bandName}`, async () => {
					const spotifyApi = this.getSpotifyClient();
					const results = await spotifyApi.artists.topTracks(spotifyArtist.id, 'US');
					return trackUris.concat(results.tracks.map((t) => t.uri));
				});
			}
		}
		if (trackUris.length > 0) {
			const playlistUrl = await step.do("Creating Playlist from found tracks", async () => {
				const poster = await this.getPosterAgent(posterIdString);
				await poster.addStatusUpdate(`Creating new playlist for ${this.env.SPOTIFY_MAIN_USER_ID}`);
				const id = this.env.SPOTIFY_USER.idFromName(this.env.SPOTIFY_MAIN_USER_ID);
				const spotifyUser = this.env.SPOTIFY_USER.get(id);
				await spotifyUser.createPlaylist(event.payload.posterSlug, "A Band Aid Playlist", trackUris);
			});
		}

		return 'done';
	}
}
