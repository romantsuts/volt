# Backgammon Web API

Backgammon Web API. Sophisticated neural net based multi-ply evalution engine for Backgammon moves.

Based on GNU Backgammon (https://www.gnu.org/software/gnubg) under GPL license.

Features:

- Calculate best moves for a given Backgammon position
- Calculate doubling cube decisions (money game & match play)

---

**Want to see the Backgammon Web API in action?** Have a look at https://github.com/foochu/bgweb-terminal.

---

## Running the REST API server

### Run via Docker

```sh
# 1 - install docker

# 2 - run the program:
docker run -p 8080:8080 -d foochu/bgweb-api:latest

# 3 - browse to http://localhost:8080
```

### Run from source

```sh
# 1 - install Go

# 2 - clone this repo

# 3 - run the program:
go run ./cmd/bgweb-api

# 4 - browse to http://localhost:8080
```

### Run tests

Run all unit tests:

```sh
go test -v ./internal/...
```

Run a Postman smoke test collection with Newman CLI:

```sh
# install Node.js >= 10

# start the HTTP server as per instruction above

# run the collection, should pass
npx newman run ./test/bgweb.postman_collection.json
```

### Re-generating boilerplate code from OpenAPI spec

After modifying `api/openapi.yaml` run the following command to update generated types & routes:

```sh
oapi-codegen --config configs/oapi-codegen.yaml api/openapi.yaml
```

## Get best moves

### Parameters

- `board` = Board layout
  - `x` = Layout for player `x`
    - `1` - `24` = Number of chequers at each point
    - `bar` = Number of chequers on bar
  - `o` = Layout for player `o`
    - `1` - `24` = Number of chequers at each point
    - `bar` = Number of chequers on bar
- `cubeful` = Is doubling cube at play? Affects equity algorithm.
- `dice` = 2-slot array of dice roll
- `max-moves` = Max number of moves to return
- `player` = Player who's turn it is to move, either `x` or `o`
- `score-moves` = Calculate equity & winning chance. If `false` just returns list of legal moves.
- `plies` = *(optional, default `2`)* Evaluation depth in plies (`0`–`4`; `0` = static neural net evaluation). Values outside the range are clamped, negative or missing = default `2`.
- `exact-plies` = *(optional, default `false`)* Force every returned move to be evaluated at exactly `plies` depth. Without it GNU Backgammon's move filter may stop the search early and return some moves evaluated shallower — see [Exact depth](#exact-depth-exact-plies).
- `cube` / `cube-owner` / `match-to` / `score` / `crawford` / `jacoby` / `beavers` = *(optional)* Doubling cube and match context, same as in [Get cube decision](#get-cube-decision). Match-aware evaluation uses the match equity table.

### Example

For example, get top moves for starting position and dice roll 3-1 for player `x`:

```
curl -L -X POST 'http://localhost:8080/api/v1/getmoves' \
-H 'accept: application/json' \
-H 'Content-Type: application/json' \
--data-raw '{
  "board": {
    "o": {
      "6": 5,
      "8": 3,
      "13": 5,
      "24": 2
    },
    "x": {
      "6": 5,
      "8": 3,
      "13": 5,
      "24": 2
    }
  },
  "cubeful": false,
  "dice": [3, 1],
  "max-moves": 3,
  "player": "x",
  "score-moves": true
}'
```

Return moves in order of preference based on equity and winning chance:

```json
[
  {
    "play": [
      {
        "from": "8",
        "to": "5"
      },
      {
        "from": "6",
        "to": "5"
      }
    ],
    "evaluation": {
      "info": {
        "cubeful": false,
        "plies": 1
      },
      "eq": 0.159,
      "diff": 0,
      "probability": {
        "win": 0.551,
        "winG": 0.174,
        "winBG": 0.013,
        "lose": 0.449,
        "loseG": 0.124,
        "loseBG": 0.005
      }
    }
  },
  {
    "play": [
      {
        "from": "13",
        "to": "10"
      },
      {
        "from": "24",
        "to": "23"
      }
    ],
    "evaluation": {
      "info": {
        "cubeful": false,
        "plies": 1
      },
      "eq": -0.009,
      "diff": -0.168,
      "probability": {
        "win": 0.497,
        "winG": 0.137,
        "winBG": 0.008,
        "lose": 0.503,
        "loseG": 0.14,
        "loseBG": 0.007
      }
    }
  },
  {
    "play": [
      {
        "from": "24",
        "to": "21"
      },
      {
        "from": "21",
        "to": "20"
      }
    ],
    "evaluation": {
      "info": {
        "cubeful": false,
        "plies": 1
      },
      "eq": -0.015,
      "diff": -0.175,
      "probability": {
        "win": 0.497,
        "winG": 0.125,
        "winBG": 0.005,
        "lose": 0.503,
        "loseG": 0.135,
        "loseBG": 0.004
      }
    }
  }
]
```

## Evaluation depth (`plies`)

Both `getmoves` and `getcubedecision` (and their WASM counterparts `wasm_get_moves` / `wasm_get_cube_decision`) accept an optional `plies` parameter:

| `plies` | Meaning | Notes |
| --- | --- | --- |
| `0` | Static neural net evaluation | Fastest, `evaluation.info.plies` = `1` for moves, `0` for cube |
| `1` | 1-ply search | |
| `2` | 2-ply search (default) | Same depth as the GNU Backgammon "2 ply" default |
| `3` | 3-ply search | Noticeably slower |
| `4` | 4-ply search | Slowest supported depth |

- Values above `4` are clamped to `4`, negative values (and omitted field) mean the default `2`.
- `evaluation.info.plies` in the response reports the depth that was **actually used**: for moves that is the effective search depth + 1, and GNU Backgammon's move filter may stop the search early when only a single candidate move survives (so a `plies: 3` request does not always return `4`).
- Cube decisions report the requested depth as-is; there is no move filter involved.

### Exact depth (`exact-plies`)

For moves `plies` is only a **ceiling**, not a guarantee (upstream GNU Backgammon behaviour):

- the move filter prunes candidates at each ply (normal filter: up to 8 moves within `0.16` of the best), and pruned moves stay in the result list with the shallower evaluation they already had;
- when the filter narrows the field down to a single candidate the search stops altogether (upstream `goto finished`), so even the best move keeps the depth reached so far. In the starting position this means every move comes back as `info.plies = 1`, i.e. a static network evaluation without any search;
- as a result a `plies: 4` request may return exactly the same numbers as `plies: 2`.

Pass `"exact-plies": true` to re-score **every** returned move at exactly `plies` depth and re-sort the list (the guarantee GNU Backgammon applies to `keyMove`). All rows then report the same `evaluation.info.plies = plies + 1`.

| Position (10 moves, 3-1) | `plies: 2` | `plies: 2`, `exact-plies: true` |
| --- | --- | --- |
| Race | 329 ms, depths `{1: 2, 3: 8}` | 73 ms, depths `{3: 10}` |
| Starting position | 17 ms, depths `{1: 10}` (no search) | 1.5 s, depths `{3: 10}` |

`exact-plies` re-scores only moves that are still shallower than `plies`, and only as many as `max-moves` asks for — the rest of the sorted list is dropped before the re-scoring, because it would never reach the response. Cube decisions ignore the flag — they are always evaluated at the requested depth, because no move filter is involved.

Recommended depths for a single position in a UI (measured on the WASM build, `max-moves: 5`, money game):

| Depth | Race | Contact | Starting position |
| --- | --- | --- | --- |
| 0 ply (static) | 4 ms | 2 ms | 40 ms |
| 2 ply | 250 ms | 1.4 s | 0.9 s |
| 3 ply | 2.8 s | 13 s | 15 s |

## Get cube decision

### Parameters

- `board` = Board layout (`x` and `o` checker counts on points `1`–`24` and `bar`)
- `player` = Player on roll considering the cube decision (`x` or `o`)
- `cube` = *(optional, default `1`)* Current value of the doubling cube (`1`, `2`, `4`, `8`, ...)
- `cube-owner` = *(optional, default `centered`)* Current owner of the cube (`centered`, `x`, or `o`)
- `plies` = *(optional, default `2`)* Evaluation depth in plies (`0`–`4`)
- `match-to` = *(optional, default `0`)* Target match score (`0` = money game)
- `score` = *(optional)* Current match score `{ "x": 0, "o": 0 }`
- `crawford` = *(optional, default `false`)* Crawford game flag (match play)
- `jacoby` = *(optional, default `false`)* Jacoby rule flag (money game)
- `beavers` = *(optional, default `false`)* Beavers allowed flag (money game)

### Example

```sh
curl -L -X POST 'http://localhost:8080/api/v1/getcubedecision' \
-H 'accept: application/json' \
-H 'Content-Type: application/json' \
--data-raw '{
  "board": {
    "x": { "1": 2, "2": 2, "3": 3, "4": 3, "5": 3, "6": 2 },
    "o": { "1": 2, "2": 2, "3": 2, "4": 3, "5": 3, "6": 3 }
  },
  "player": "x",
  "cube": 1,
  "cube-owner": "centered",
  "plies": 2
}'
```

Response:

```json
{
  "decision": "DOUBLE_TAKE",
  "recommendation": "Double, take",
  "double": true,
  "response": "take",
  "equity": {
    "optimal": 0.612,
    "no-double": 0.608,
    "double-take": 0.612,
    "double-pass": 1,
    "cubeless": 0.396
  },
  "evaluation": {
    "info": {
      "cubeful": true,
      "plies": 2
    },
    "probability": {
      "win": 0.698,
      "winG": 0,
      "winBG": 0,
      "lose": 0.302,
      "loseG": 0,
      "loseBG": 0
    }
  }
}
```

## Web Assembly

Web Assembly allows to run the API functions directly in the browser or Node.js without a need for a backend server. Logic, runtime & data files are all bundled into `lib.wasm`.

Build wasm:

```sh
# 1 - install Go

# 2 - clone this repo

# 3 - build wasm (generates `lib.wasm` and copies `wasm_exec.js`)
./scripts/buildwasm.sh
```

Web Assembly declares global JS functions `wasm_get_moves()` and `wasm_get_cube_decision()`. See `examples/node_wasm_example.js` for a complete Node.js usage example.

```js
const go = new Go();

WebAssembly.instantiateStreaming(fetch("lib.wasm"), go.importObject).then(async (result) => {
  await go.run(result.instance);
});
```

Web Assembly declares global JS function `wasm_get_moves()`. Example usage:

```ts
let input = JSON.stringify({
  board: {
    o: {
      "6": 5,
      "8": 3,
      "13": 5,
      "24": 2,
    },
    x: {
      "6": 5,
      "8": 3,
      "13": 5,
      "24": 2,
    },
  },
  cubeful: false,
  dice: [3, 1],
  "max-moves": 3,
  player: "x",
  "score-moves": true,
});

let output = global.wasm_get_moves(input);

let moves = JSON.parse(output);

console.log(moves);
```
