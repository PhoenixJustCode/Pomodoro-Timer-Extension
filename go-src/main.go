package main

import (
	"strconv"
	"time"

	"github.com/gopherjs/gopherjs/js"
)

var (
	timerID          *js.Object
	originalMins     int
	remainingSecs    int
	isPaused         bool
	isRunning        bool
	titleBtnPressed  = false
	innerTimer       = false
	SoundTimer       *js.Object
)

func formatTime(seconds int) string {
	min := seconds / 60
	sec := seconds % 60
	return pad(min) + ":" + pad(sec)
}

func pad(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

func updateDisplay() {
	js.Global.Get("document").Call("getElementById", "title").Set("innerText", formatTime(remainingSecs))
}

func stopTimer(doc *js.Object) {
	if timerID != nil {
		js.Global.Call("clearInterval", timerID)
		timerID = nil
	}
	if SoundTimer != nil {
		SoundTimer.Call("pause")
	}
	saveRunningState(false) // 👈 сохраняем что остановлено
	// clearStart()
	isPaused = true
	isRunning = false
}

func recoverOriginalTime(doc *js.Object) {
	if originalMins > 0 {
		stopTimer(doc)
		remainingSecs = originalMins * 60
		updateDisplay()
	}
}

func saveStart(duration int) {
	storage := js.Global.Get("localStorage")
	storage.Call("setItem", "startTime", strconv.FormatInt(time.Now().Unix(), 10))
	storage.Call("setItem", "duration", strconv.Itoa(duration))
}

func loadRemainingSecs() int {
	storage := js.Global.Get("localStorage")
	startStr := storage.Call("getItem", "startTime")
	durationStr := storage.Call("getItem", "duration")

	if startStr == nil || durationStr == nil {
		return 0
	}

	startTime, err1 := strconv.ParseInt(startStr.String(), 10, 64)
	duration, err2 := strconv.Atoi(durationStr.String())
	if err1 != nil || err2 != nil {
		return 0
	}

	elapsed := int(time.Now().Unix() - startTime)
	remaining := duration - elapsed
	if remaining < 0 {
		return 0
	}
	return remaining
}

func clearStart() {
	storage := js.Global.Get("localStorage")
	storage.Call("removeItem", "startTime")
	storage.Call("removeItem", "duration")
}

func saveRunningState(running bool) {
	state := "false"
	if running {
		state = "true"
	}
	js.Global.Get("localStorage").Call("setItem", "wasRunning", state)
}

func loadRunningState() bool {
	state := js.Global.Get("localStorage").Call("getItem", "wasRunning")
	return state != nil && state.String() == "true"
}

func startTimer(doc *js.Object) {
	if isRunning || remainingSecs <= 0 {
		return
	}

	saveStart(remainingSecs)
	saveRunningState(true) // 👈 сохраняем что запущен

	timerID = js.Global.Call("setInterval", func() {
		remainingSecs = loadRemainingSecs()

		if remainingSecs > 0 {
			if remainingSecs == 5 {
				SoundTimer = playSound("fiveSound")
			}
			updateDisplay()
		} else {
			remainingSecs = 0
			playSound("lastSound")
			stopTimer(doc)
			clearStart()
			updateDisplay()
		}
	}, 1000)

	isPaused = false
	isRunning = true
}

func timerUpdate(doc *js.Object) {
	input := js.Global.Call("prompt", "Введите количество минут", "25")
	mins, err := strconv.Atoi(input.String())
	if err == nil && mins >= 0 {
		if mins == 0 {
			originalMins = 0
			remainingSecs = 10
		} else {
			originalMins = mins
			remainingSecs = mins * 60
		}
		updateDisplay()
	}
}

func playSound(sound string) *js.Object {
	audio := js.Global.Get("document").Call("getElementById", sound)
	if audio != nil {
		audio.Call("play")
	}
	return audio
}

func main() {
	doc := js.Global.Get("document")
	remainingSecs = loadRemainingSecs()

	if remainingSecs > 0 && loadRunningState() {
		updateDisplay()
		startTimer(doc)
	} else {
		remainingSecs = 0
		updateDisplay()
	}

	doc.Call("getElementById", "title").Call("addEventListener", "click", func() {
		titleBtnPressed = true
		timerUpdate(doc)
	})

	doc.Call("getElementById", "startBtn").Call("addEventListener", "click", func() {
		if titleBtnPressed {
			startTimer(doc)
		} else {
			if remainingSecs > 0 {
				startTimer(doc)
				titleBtnPressed = true
			} else  {
				timerUpdate(doc)
				startTimer(doc)
			}	
		}
	})

	doc.Call("getElementById", "stopBtn").Call("addEventListener", "click", func() {
		stopTimer(doc)
	})

	doc.Call("getElementById", "recoverBtn").Call("addEventListener", "click", func() {
		recoverOriginalTime(doc)
	})
}
