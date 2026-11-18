package api

import (
	"bgweb-api/internal/gnubg"
	"bgweb-api/internal/openapi"
	"fmt"
)

func GetCubeDecision(args openapi.CubeArgs) (*openapi.CubeDecision, error) {
	var board = gnubg.TanBoard{
		layoutToGNU(args.Board.X),
		layoutToGNU(args.Board.O),
	}

	var player int = 1
	if args.Player == openapi.CubeArgsPlayerO {
		player = 0
	}

	var cubeOwner int = -1
	if args.CubeOwner != nil {
		switch *args.CubeOwner {
		case openapi.CubeArgsCubeOwnerX:
			cubeOwner = 1
		case openapi.CubeArgsCubeOwnerO:
			cubeOwner = 0
		case openapi.CubeArgsCubeOwnerCentered:
			cubeOwner = -1
		}
	}

	var score [2]int
	if args.Score != nil {
		score[0] = fromPtr(args.Score.O, 0)
		score[1] = fromPtr(args.Score.X, 0)
	}

	opts := gnubg.CubeOptions{
		Cube:      fromPtr(args.Cube, 1),
		CubeOwner: cubeOwner,
		MatchTo:   fromPtr(args.MatchTo, 0),
		Score:     score,
		Crawford:  fromPtr(args.Crawford, false),
		Jacoby:    fromPtr(args.Jacoby, false),
		Beavers:   fromPtr(args.Beavers, false),
		Plies:     normalizePliesArg(args.Plies),
	}

	res, err := gnubg.FindCubeDecision(board, player, opts)
	if err != nil {
		return nil, fmt.Errorf("error in gnubg.FindCubeDecision(): %v", err)
	}

	return &openapi.CubeDecision{
		Decision:       res.Decision.String(),
		Recommendation: res.Decision.Recommendation(),
		Double:         res.Decision.ShouldDouble(),
		Response:       openapi.CubeDecisionResponse(res.Decision.Response()),
		Equity: openapi.CubeEquity{
			Optimal:    outputEquity(res.OptimalEquity),
			NoDouble:   outputEquity(res.NoDoubleEquity),
			DoubleTake: outputEquity(res.DoubleTakeEq),
			DoublePass: outputEquity(res.DoublePassEq),
			Cubeless:   outputEquity(res.CubelessEquity),
		},
		Evaluation: openapi.CubeEvaluation{
			Info: openapi.EvalInfo{
				Cubeful: res.Info.Cubeful,
				Plies:   res.Info.Plies,
			},
			Probability: openapi.Probability{
				Win:    fformat(res.ProbWin),
				WinG:   fformat(res.ProbWinG),
				WinBG:  fformat(res.ProbWinBG),
				Lose:   fformat(res.ProbLose),
				LoseG:  fformat(res.ProbLoseG),
				LoseBG: fformat(res.ProbLoseBG),
			},
		},
	}, nil
}
