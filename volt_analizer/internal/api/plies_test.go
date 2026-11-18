package api

import (
	"bgweb-api/internal/openapi"
	"reflect"
	"testing"
)

// raceArgs — позиция в чистом беговом окончании. На ней даже 4 ply считаются быстро,
// поэтому тест не тормозит остальной набор.
func raceArgs(plies *int) openapi.MoveArgs {
	return openapi.MoveArgs{
		Board: openapi.Board{
			O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
			X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
		},
		Dice:       []int{3, 1},
		Player:     "x",
		ScoreMoves: toPtr(true),
		MaxMoves:   toPtr(6),
		Plies:      plies,
	}
}

func raceCubeArgs(plies *int) openapi.CubeArgs {
	return openapi.CubeArgs{
		Board: openapi.Board{
			O: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(3), N4: toPtr(3), N5: toPtr(3), N6: toPtr(2)},
			X: openapi.CheckerLayout{N1: toPtr(2), N2: toPtr(2), N3: toPtr(2), N4: toPtr(3), N5: toPtr(3), N6: toPtr(3)},
		},
		Player: "o",
		Plies:  plies,
	}
}

// topDepth возвращает глубину (в ply GNU Backgammon), на которой реально посчитан лучший ход.
// В ответе API это Info.Plies, т.е. nPlies+1.
func topDepth(t *testing.T, args openapi.MoveArgs) int {
	t.Helper()
	moves, err := GetMoves(args)
	if err != nil {
		t.Fatalf("GetMoves(plies=%v) error = %v", args.Plies, err)
	}
	if len(moves) == 0 {
		t.Fatalf("GetMoves(plies=%v) вернул пустой список", args.Plies)
	}
	return moves[0].Evaluation.Info.Plies
}

func TestGetMovesPliesHonored(t *testing.T) {
	once.Do(setup)

	// 0 ply (статическая оценка) -> глубина 1; каждый следующий запрошенный ply
	// не уменьшает фактическую глубину.
	depths := make(map[int]int)
	for _, p := range []int{0, 1, 2, 3, 4} {
		depths[p] = topDepth(t, raceArgs(toPtr(p)))
	}
	if depths[0] != 1 {
		t.Errorf("plies=0: глубина = %d, ожидалось 1 (статическая оценка)", depths[0])
	}
	if depths[1] != 2 {
		t.Errorf("plies=1: глубина = %d, ожидалось 2", depths[1])
	}
	if depths[2] != 3 {
		t.Errorf("plies=2: глубина = %d, ожидалось 3", depths[2])
	}
	for _, p := range []int{1, 2, 3, 4} {
		if depths[p] < depths[p-1] {
			t.Errorf("глубина не должна падать: plies=%d даёт %d, а plies=%d даёт %d",
				p, depths[p], p-1, depths[p-1])
		}
	}
	// Отдельные запросы ограничиваются диапазоном 0..4 и значением по умолчанию для отрицательных.
	if got, want := topDepth(t, raceArgs(nil)), depths[2]; got != want {
		t.Errorf("без plies глубина = %d, ожидалась как у plies=2 (%d)", got, want)
	}
	if got, want := topDepth(t, raceArgs(toPtr(-1))), depths[2]; got != want {
		t.Errorf("plies=-1 глубина = %d, ожидалась как у plies=2 (%d)", got, want)
	}
	if got, want := topDepth(t, raceArgs(toPtr(9))), depths[4]; got != want {
		t.Errorf("plies=9 (вне диапазона) глубина = %d, ожидалась как у plies=4 (%d)", got, want)
	}
}

func TestGetCubeDecisionPliesHonored(t *testing.T) {
	once.Do(setup)

	// У куб-решения нет отсечения по move filter, поэтому запрошенная глубина
	// всегда попадает в ответ как Evaluation.Info.Plies.
	for _, tc := range []struct {
		plies   *int
		wantOut int
	}{
		{nil, 2},       // по умолчанию 2 ply
		{toPtr(0), 0},  // 0 ply (статическая оценка)
		{toPtr(1), 1},  // 1 ply
		{toPtr(2), 2},  // 2 ply
		{toPtr(3), 3},  // 3 ply
		{toPtr(4), 4},  // 4 ply
		{toPtr(9), 4},  // вне диапазона -> 4 ply
		{toPtr(-1), 2}, // отрицательное -> по умолчанию
	} {
		res, err := GetCubeDecision(raceCubeArgs(tc.plies))
		if err != nil {
			t.Fatalf("GetCubeDecision(plies=%v) error = %v", tc.plies, err)
		}
		if res.Evaluation.Info.Plies != tc.wantOut {
			t.Errorf("GetCubeDecision(plies=%v).Info.Plies = %d, ожидалось %d", tc.plies, res.Evaluation.Info.Plies, tc.wantOut)
		}
	}
}

// Явно переданные plies=2 не должны менять результат по сравнению с вызовом
// без параметров (разные ветки кода в GetMoves: с CubeOptions и без них).
func TestGetMovesDefaultPliesMatchesLegacy(t *testing.T) {
	once.Do(setup)

	legacy, err := GetMoves(raceArgs(nil))
	if err != nil {
		t.Fatal(err)
	}
	withOpts, err := GetMoves(raceArgs(toPtr(2)))
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy) != len(withOpts) {
		t.Fatalf("разное число вариантов: %d и %d", len(legacy), len(withOpts))
	}
	for i := range legacy {
		if !reflect.DeepEqual(legacy[i], withOpts[i]) {
			t.Errorf("вариант %d отличается:\n без plies: %+v\n c plies:  %+v", i, legacy[i], withOpts[i])
		}
	}
}
