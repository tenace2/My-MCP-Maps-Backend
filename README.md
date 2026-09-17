# My MCP Maps Backend

This repository contains the backend API for the My MCP Maps application. It is a small Node.js and Express server that accepts a user's map-related question, sends it to Google's Gemini API, and returns a structured response for the frontend.

The backend does not render the map. The frontend uses the returned `mapHint` and `places` values to update its map interface.

## How a request works

1. The frontend sends a `POST /api/chat` request containing a `prompt`.
2. The backend checks that the prompt is a non-empty string and that `GEMINI_API_KEY` is configured.
3. The backend sends the prompt to the configured Gemini model.
4. Gemini is instructed to return JSON with `reply`, `mapHint`, `places`, and `debug` fields.
5. The backend validates those fields before returning the response.
6. The frontend displays the reply and uses `mapHint` to perform a map search.

## Requirements

- Node.js with support for the version used by your deployment environment
- A Google Gemini API key
- Access to a Gemini model supported by the API key

## Installation

From this directory:

```bash
npm install
```

## Configuration

For local development, create a `.env.local` file in the backend directory:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.6-flash
PORT=3001
```

`GEMINI_API_KEY` is required. Do not commit this file or expose the key in frontend code.

`GEMINI_MODEL` is optional. If it is omitted, the server currently defaults to `gemini-3.6-flash`. The selected model must be available to the Gemini API key and account in use.

`PORT` is optional. The server uses the hosting provider's `PORT` value when one is supplied, otherwise it listens on port `3001`.

The server loads `.env.local` for local development. On Railway or another host, define these values in the service's environment variables instead of uploading `.env.local`.

## Running locally

Start the server normally:

```bash
npm start
```

For development, use Node's file-watching mode:

```bash
npm run dev
```

A successful startup prints a message similar to:

```text
Server listening on http://localhost:3001
```

The actual port may differ when `PORT` is set by the hosting environment.

## API endpoints

### `GET /`

A simple health check. It confirms that the Express server is running.

Example response:

```json
{
  "status": "ok",
  "message": "MCP Maps backend is running."
}
```

Example request:

```bash
curl http://localhost:3001/
```

### `GET /api/usage`

Returns the backend's Gemini request counters for the current UTC day.

Example response:

```json
{
  "usageToday": {
    "date": "2026-09-17",
    "attempted": 3,
    "success": 2,
    "error": 1
  }
}
```

These counters are held in process memory. They reset when the server restarts or redeploys, and they are not a permanent usage history or a replacement for Google's usage dashboard.

### `POST /api/chat`

Sends a prompt to Gemini.

Request body:

```json
{
  "prompt": "Show me museums in London"
}
```

Successful response:

```json
{
  "reply": "Here are some museums to explore in London.",
  "mapHint": "museums in London, UK",
  "places": [
    "The British Museum",
    "Victoria and Albert Museum"
  ],
  "debug": "Interpreted the request as a London museum search.",
  "model": "gemini-3.6-flash",
  "inputTokens": 120,
  "outputTokens": 80,
  "usageToday": {
    "date": "2026-09-17",
    "attempted": 1,
    "success": 1,
    "error": 0
  }
}
```

The response fields are:

- `reply`: conversational text for the user.
- `mapHint`: a search phrase the frontend can send to its map interface. It may be an empty string when no map location is relevant.
- `places`: an array of place names or short descriptions, limited to 24 entries.
- `debug`: a short developer-facing description of how the request was interpreted.
- `model`: the model reported by the Gemini response, or the configured model name.
- `inputTokens` and `outputTokens`: token counts when Gemini provides usage metadata.
- `usageToday`: the current in-memory counters.

Example request:

```bash
curl -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Show me museums in London"}'
```

## Error responses

The backend includes an `errorStatus` and `errorMessage` to help the frontend display useful diagnostics. Common statuses include:

- `400`: the request body does not contain a non-empty string `prompt`.
- `401`: the Gemini API key was rejected or is not authorized.
- `403`: the request was forbidden because of permissions or authentication.
- `404`: the configured Gemini model or resource was not found.
- `429`: Gemini quota or rate limiting was encountered.
- `502`: Gemini returned an unusable response, or an otherwise unclassified upstream error occurred.
- `503`: Gemini is temporarily unavailable, overloaded, or the backend has no API key configured.

A Gemini error response generally looks like this:

```json
{
  "error": "Gemini request failed.",
  "errorStatus": 503,
  "errorMessage": "...",
  "errorDetails": "...",
  "usageToday": {
    "date": "2026-09-17",
    "attempted": 1,
    "success": 0,
    "error": 1
  }
}
```

## Retry behavior

Temporary Gemini failures can happen during high demand or rate limiting. The backend retries errors identified as temporary, including HTTP `500`, `503`, and `429` responses, as well as matching Gemini messages such as `UNAVAILABLE` and `RESOURCE_EXHAUSTED`.

There are up to three total attempts. The waits increase between attempts and include a small random amount of jitter:

- after the first failed attempt: about 1 to 1.5 seconds
- after the second failed attempt: about 2 to 2.5 seconds

If the final attempt fails, the backend returns the mapped error to the frontend. Permanent errors such as an invalid model or invalid API key are not retried.

## Deployment on Railway

1. Connect the GitHub repository to a Railway service.
2. Set the service variables:
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (optional, but set it to a currently supported model)
3. Railway supplies `PORT` automatically.
4. Railway runs the `npm start` script from `package.json`.
5. After pushing a commit to the deployed branch, wait for Railway to build and redeploy the service.
6. Check the deployment logs, then test the public service URL with `GET /`.

Example health check after deployment:

```bash
curl https://your-railway-domain.example/
```

Keep the Gemini API key only in Railway's private variables. It should never be placed in the frontend's `VITE_*` variables or committed to GitHub.

## Project files

- `server.js`: Express server, Gemini request handling, response validation, retry logic, and usage counters.
- `package.json`: runtime dependencies and start scripts.
- `.env.local`: local-only environment variables; this file should remain uncommitted.
