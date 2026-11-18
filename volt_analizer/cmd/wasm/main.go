package main

import (
	"bgweb-api/internal/api"
	"bgweb-api/internal/gnubg"
	"bgweb-api/internal/openapi"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"syscall/js"
)

//go:embed data
var data embed.FS

func main() {
	c := make(chan struct{}, 0)

	// root embedded fs to data/
	dataDir, err := fs.Sub(data, "data")
	if err != nil {
		panic(err)
	}

	if err := gnubg.Init(dataDir); err != nil {
		panic(err)
	}

	println("WASM Go Initialized")
	// register functions
	{
		js.Global().Set("wasm_get_moves", js.FuncOf(getMoves))
		js.Global().Set("wasm_get_cube_decision", js.FuncOf(getCubeDecision))
	}
	<-c
}

type legacyMatchInfo struct {
	MatchTo   *int            `json:"match-to"`
	Score     json.RawMessage `json:"score"`
	Crawford  *bool           `json:"crawford"`
	CubeValue *int            `json:"cube-value"`
	CubeOwner *string         `json:"cube-owner"`
}

type legacyEnvelope struct {
	Match *legacyMatchInfo `json:"match"`
}

func parseLegacyScore(raw json.RawMessage) *openapi.MatchScore {
	if len(raw) == 0 {
		return nil
	}
	var obj openapi.MatchScore
	if err := json.Unmarshal(raw, &obj); err == nil && (obj.O != nil || obj.X != nil) {
		return &obj
	}
	var arr []int
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) >= 2 {
		o, x := arr[0], arr[1]
		return &openapi.MatchScore{O: &o, X: &x}
	}
	return nil
}

func getMoves(this js.Value, input []js.Value) interface{} {
	rawBytes := []byte(input[0].String())
	var args openapi.MoveArgs

	if err := json.Unmarshal(rawBytes, &args); err != nil {
		return fmt.Sprintf("{\"error\": \"%v\"}", err.Error())
	}

	var env legacyEnvelope
	if err := json.Unmarshal(rawBytes, &env); err == nil && env.Match != nil {
		m := env.Match
		if args.MatchTo == nil && m.MatchTo != nil {
			args.MatchTo = m.MatchTo
		}
		if args.Crawford == nil && m.Crawford != nil {
			args.Crawford = m.Crawford
		}
		if args.Cube == nil && m.CubeValue != nil {
			args.Cube = m.CubeValue
		}
		if args.CubeOwner == nil && m.CubeOwner != nil {
			co := openapi.MoveArgsCubeOwner(*m.CubeOwner)
			args.CubeOwner = &co
		}
		if args.Score == nil {
			if sc := parseLegacyScore(m.Score); sc != nil {
				args.Score = sc
			}
		}
	}

	moves, err := api.GetMoves(args)

	if err != nil {
		return fmt.Sprintf("{\"error\": \"%v\"}", err.Error())
	}

	bytes, err := json.Marshal(moves)

	if err != nil {
		return fmt.Sprintf("{\"error\": \"%v\"}", err.Error())
	}

	return js.ValueOf(string(bytes))
}

func getCubeDecision(this js.Value, input []js.Value) interface{} {
	rawBytes := []byte(input[0].String())
	var args openapi.CubeArgs

	if err := json.Unmarshal(rawBytes, &args); err != nil {
		return fmt.Sprintf("{\"error\": \"%v\"}", err.Error())
	}

	var env legacyEnvelope
	if err := json.Unmarshal(rawBytes, &env); err == nil && env.Match != nil {
		m := env.Match
		if args.MatchTo == nil && m.MatchTo != nil {
			args.MatchTo = m.MatchTo
		}
		if args.Crawford == nil && m.Crawford != nil {
			args.Crawford = m.Crawford
		}
		if args.Cube == nil && m.CubeValue != nil {
			args.Cube = m.CubeValue
		}
		if args.CubeOwner == nil && m.CubeOwner != nil {
			co := openapi.CubeArgsCubeOwner(*m.CubeOwner)
			args.CubeOwner = &co
		}
		if args.Score == nil {
			if sc := parseLegacyScore(m.Score); sc != nil {
				args.Score = sc
			}
		}
	}

	decision, err := api.GetCubeDecision(args)

	if err != nil {
		return fmt.Sprintf("{\"error\": \"%v\"}", err.Error())
	}

	bytes, err := json.Marshal(decision)

	if err != nil {
		return fmt.Sprintf("{\"error\": \"%v\"}", err.Error())
	}

	return js.ValueOf(string(bytes))
}
