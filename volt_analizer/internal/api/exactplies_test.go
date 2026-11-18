package api

import (
	"bgweb-api/internal/openapi"
	"testing"
)

// exactPliesArgs — середина партии: move filter отсеивает часть ходов, поэтому
// без exact-plies глубины в ответе разъезжаются (это и проверяем ниже).
func exactPliesArgs(exact bool, plies int) openapi.MoveArgs {
	return openapi.MoveArgs{
		Board: openapi.Board{
			O: openapi.CheckerLayout{N6: toPtr(5), N8: toPtr(3), N13: toPtr(5), N24: toPtr(2)},
			X: openapi.CheckerLayout{N1: toPtr(2), N12: toPtr(5), N17: toPtr(3), N19: toPtr(5)},
		},
		Dice:       []int{3, 1},
		Player:     "x",
		ScoreMoves: toPtr(true),
		MaxMoves:   toPtr(6),
		Plies:      toPtr(plies),
		ExactPlies: toPtr(exact),
	}
}

func getMovesOrFail(t *testing.T, args openapi.MoveArgs) []openapi.Move {
	t.Helper()
	moves, err := GetMoves(args)
	if err != nil {
		t.Fatalf("GetMoves(plies=%v, exact-plies=%v) error = %v", args.Plies, args.ExactPlies, err)
	}
	if len(moves) == 0 {
		t.Fatal("GetMoves() вернул пустой список ходов")
	}
	return moves
}

func TestExactPliesUniformDepth(t *testing.T) {
	once.Do(setup)

	for _, plies := range []int{1, 2, 3} {
		moves := getMovesOrFail(t, exactPliesArgs(true, plies))
		for i, m := range moves {
			if want := plies + 1; m.Evaluation.Info.Plies != want {
				t.Errorf("plies=%d, exact-plies: ход %d имеет info.plies = %d, ожидалось %d",
					plies, i, m.Evaluation.Info.Plies, want)
			}
		}
		// После досчёта лучший ход обязан остаться первым, diff первого = 0.
		if moves[0].Evaluation.Diff != 0 {
			t.Errorf("plies=%d: diff лучшего хода = %v, ожидалось 0", plies, moves[0].Evaluation.Diff)
		}
		for i := 1; i < len(moves); i++ {
			if moves[i].Evaluation.Diff > 0 {
				t.Errorf("plies=%d: ход %d имеет положительный diff %v — сортировка после досчёта неверна",
					plies, i, moves[i].Evaluation.Diff)
			}
		}
	}
}

func TestExactPliesMatchesPlainAtSameDepth(t *testing.T) {
	once.Do(setup)

	// exact-plies не меняет математику: лучший ход на глубине 2 совпадает
	// с обычным режимом на той же глубине 2 (просто досчитаны все варианты).
	plain := getMovesOrFail(t, exactPliesArgs(false, 2))
	exact := getMovesOrFail(t, exactPliesArgs(true, 2))
	if plain[0].Evaluation.Eq != exact[0].Evaluation.Eq {
		t.Errorf("eq лучшего хода: обычный режим %v, exact-plies %v — ожидалось совпадение",
			plain[0].Evaluation.Eq, exact[0].Evaluation.Eq)
	}
}

func TestExactPliesZeroDoesNothing(t *testing.T) {
	once.Do(setup)

	// plies=0 — это статическая оценка сети, форсировать нечего.
	moves := getMovesOrFail(t, exactPliesArgs(true, 0))
	for i, m := range moves {
		if m.Evaluation.Info.Plies != 1 {
			t.Errorf("ход %d: info.plies = %d, ожидалось 1", i, m.Evaluation.Info.Plies)
		}
	}
}
