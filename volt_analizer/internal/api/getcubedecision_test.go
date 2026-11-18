package api

import (
	"bgweb-api/internal/openapi"
	"testing"
)

func TestGetCubeDecision(t *testing.T) {
	once.Do(setup)

	tests := []struct {
		name          string
		args          openapi.CubeArgs
		wantDecision  string
		wantDouble    bool
		wantResponse  openapi.CubeDecisionResponse
		wantRecommend string
		checkEquities func(t *testing.T, eq openapi.CubeEquity)
	}{
		{
			name: "initial position should be NODOUBLE_TAKE",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N6: toPtr(5), N8: toPtr(3), N13: toPtr(5), N24: toPtr(2)},
					O: openapi.CheckerLayout{N6: toPtr(5), N8: toPtr(3), N13: toPtr(5), N24: toPtr(2)},
				},
				Player: openapi.CubeArgsPlayerX,
				Plies:  toPtr(0),
			},
			wantDecision:  "NODOUBLE_TAKE",
			wantDouble:    false,
			wantResponse:  openapi.CubeDecisionResponseTake,
			wantRecommend: "No double, take",
			checkEquities: func(t *testing.T, eq openapi.CubeEquity) {
				if eq.Optimal != eq.NoDouble {
					t.Errorf("expected Optimal (%v) == NoDouble (%v)", eq.Optimal, eq.NoDouble)
				}
				if eq.NoDouble <= eq.DoubleTake {
					t.Errorf("expected NoDouble (%v) > DoubleTake (%v) in initial position", eq.NoDouble, eq.DoubleTake)
				}
				if eq.DoublePass != 1.0 {
					t.Errorf("expected DoublePass == 1.0, got %v", eq.DoublePass)
				}
			},
		},
		{
			name: "race advantage should be DOUBLE_TAKE",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					// Pure race: X is ahead in pips, good doubling window
					X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
				},
				Player: openapi.CubeArgsPlayerX,
				Plies:  toPtr(0),
			},
			wantDecision:  "DOUBLE_TAKE",
			wantDouble:    true,
			wantResponse:  openapi.CubeDecisionResponseTake,
			wantRecommend: "Double, take",
			checkEquities: func(t *testing.T, eq openapi.CubeEquity) {
				if eq.Optimal != eq.DoubleTake {
					t.Errorf("expected Optimal (%v) == DoubleTake (%v)", eq.Optimal, eq.DoubleTake)
				}
				if eq.DoubleTake < eq.NoDouble || eq.DoublePass <= eq.DoubleTake {
					t.Errorf("expected DoublePass (%v) > DoubleTake (%v) >= NoDouble (%v)", eq.DoublePass, eq.DoubleTake, eq.NoDouble)
				}
			},
		},
		{
			name: "overwhelming race lead should be DOUBLE_PASS",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					// X has 2 checkers left on 1-point, O has 6 checkers left
					X: openapi.CheckerLayout{N1: toPtr(2)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2)},
				},
				Player: openapi.CubeArgsPlayerX,
				Plies:  toPtr(0),
			},
			wantDecision:  "DOUBLE_PASS",
			wantDouble:    true,
			wantResponse:  openapi.CubeDecisionResponsePass,
			wantRecommend: "Double, pass",
			checkEquities: func(t *testing.T, eq openapi.CubeEquity) {
				if eq.Optimal != 1.0 {
					t.Errorf("expected Optimal == 1.0, got %v", eq.Optimal)
				}
				if eq.DoubleTake < eq.DoublePass {
					t.Errorf("expected DoubleTake (%v) >= DoublePass (%v)", eq.DoubleTake, eq.DoublePass)
				}
			},
		},
		{
			name: "too good to double when crushing with gammon threat and Jacoby off",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					// X has full 6-prime home board and 2 checkers already off; O has 2 on bar and 13 in X's outfield
					X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(2), N5: toPtr(2), N6: toPtr(3)},
					O: openapi.CheckerLayout{N20: toPtr(13), Bar: toPtr(2)},
				},
				Player: openapi.CubeArgsPlayerX,
				Jacoby: toPtr(false),
				Plies:  toPtr(0),
			},
			wantDecision:  "TOOGOOD_PASS",
			wantDouble:    false,
			wantResponse:  openapi.CubeDecisionResponsePass,
			wantRecommend: "Too good to double, pass",
			checkEquities: func(t *testing.T, eq openapi.CubeEquity) {
				if eq.NoDouble <= 1.0 {
					t.Errorf("expected NoDouble (%v) > 1.0 when too good to double", eq.NoDouble)
				}
			},
		},
		{
			name: "redouble when X owns 2-cube",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
				},
				Player:    openapi.CubeArgsPlayerX,
				Cube:      toPtr(2),
				CubeOwner: toPtr(openapi.CubeArgsCubeOwnerX),
				Plies:     toPtr(0),
			},
			wantDecision:  "REDOUBLE_TAKE",
			wantDouble:    true,
			wantResponse:  openapi.CubeDecisionResponseTake,
			wantRecommend: "Redouble, take",
		},
		{
			name: "cube unavailable when owned by opponent",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N1: toPtr(2)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2)},
				},
				Player:    openapi.CubeArgsPlayerX,
				Cube:      toPtr(2),
				CubeOwner: toPtr(openapi.CubeArgsCubeOwnerO),
				Plies:     toPtr(0),
			},
			wantDecision:  "NOT_AVAILABLE",
			wantDouble:    false,
			wantResponse:  openapi.CubeDecisionResponseNone,
			wantRecommend: "Cube not available",
		},
		{
			name: "dead cube for leader in post-Crawford match play",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
				},
				Player:   openapi.CubeArgsPlayerX,
				MatchTo:  toPtr(5),
				Score:    &openapi.MatchScore{X: toPtr(4), O: toPtr(2)},
				Crawford: toPtr(false),
				Plies:    toPtr(0),
			},
			wantDecision:  "NODOUBLE_DEADCUBE",
			wantDouble:    false,
			wantResponse:  openapi.CubeDecisionResponseTake,
			wantRecommend: "Never double, take (dead cube)",
		},
		{
			name: "initial position with beavers enabled should be NODOUBLE_BEAVER",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N6: toPtr(5), N8: toPtr(3), N13: toPtr(5), N24: toPtr(2)},
					O: openapi.CheckerLayout{N6: toPtr(5), N8: toPtr(3), N13: toPtr(5), N24: toPtr(2)},
				},
				Player:  openapi.CubeArgsPlayerX,
				Beavers: toPtr(true),
				Plies:   toPtr(0),
			},
			wantDecision:  "NODOUBLE_BEAVER",
			wantDouble:    false,
			wantResponse:  openapi.CubeDecisionResponseBeaver,
			wantRecommend: "No double, beaver",
		},
		{
			name: "2-ply race advantage for player O should be DOUBLE_TAKE",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
				},
				Player: openapi.CubeArgsPlayerO,
				Plies:  toPtr(2),
			},
			wantDecision:  "DOUBLE_TAKE",
			wantDouble:    true,
			wantResponse:  openapi.CubeDecisionResponseTake,
			wantRecommend: "Double, take",
		},
		{
			name: "2-ply match play (5pt match, score 2-2) should be DOUBLE_TAKE",
			args: openapi.CubeArgs{
				Board: openapi.Board{
					X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
					O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
				},
				Player:   openapi.CubeArgsPlayerX,
				MatchTo:  toPtr(5),
				Score:    &openapi.MatchScore{X: toPtr(2), O: toPtr(2)},
				Crawford: toPtr(false),
				Plies:    toPtr(2),
			},
			wantDecision:  "DOUBLE_TAKE",
			wantDouble:    true,
			wantResponse:  openapi.CubeDecisionResponseTake,
			wantRecommend: "Double, take",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := GetCubeDecision(tt.args)
			if err != nil {
				t.Fatalf("GetCubeDecision() unexpected error = %v", err)
			}
			if got.Decision != tt.wantDecision {
				t.Errorf("Decision = %v, want %v (equity=%+v)", got.Decision, tt.wantDecision, got.Equity)
			}
			if got.Double != tt.wantDouble {
				t.Errorf("Double = %v, want %v", got.Double, tt.wantDouble)
			}
			if got.Response != tt.wantResponse {
				t.Errorf("Response = %v, want %v", got.Response, tt.wantResponse)
			}
			if got.Recommendation != tt.wantRecommend {
				t.Errorf("Recommendation = %q, want %q", got.Recommendation, tt.wantRecommend)
			}
			if tt.checkEquities != nil {
				tt.checkEquities(t, got.Equity)
			}
		})
	}
}
