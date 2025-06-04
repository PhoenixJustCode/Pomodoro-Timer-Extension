package main

import (
	"strconv"
	"github.com/gopherjs/gopherjs/js"
)

var (
	timerID       *js.Object
	originalMins  int    // Изначальные минуты, введённые пользователем
	remainingSecs int    // Сколько сейчас осталось
	isPaused      bool   // Включен ли таймер
	isRunning     bool   // Чтобы не запускать дважды
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

func stopTimer() {
	if timerID != nil {
		js.Global.Call("clearInterval", timerID)
		timerID = nil
		isPaused = true
		isRunning = false
	}
}

func recoverOriginalTime() {
	if originalMins > 0 {
		stopTimer()
		remainingSecs = originalMins * 60
		updateDisplay()
	}
}

func startTimer() {
	if isRunning || remainingSecs <= 0 {
		return
	}
	timerID = js.Global.Call("setInterval", func() {
		if remainingSecs > 0 {
			remainingSecs--
			updateDisplay()
		} else {
			stopTimer()
		}
	}, 1000)
	isPaused = false
	isRunning = true
}

func main() {
	updateDisplay()
	doc := js.Global.Get("document")

	title := doc.Call("getElementById", "title")
	title.Call("addEventListener", "click", func() {
		input := js.Global.Call("prompt", "Введите количество минут", "25")
		mins, err := strconv.Atoi(input.String())
		if err == nil && mins > 0 {
			originalMins = mins
			remainingSecs = mins * 60
			updateDisplay()
		}
	})

	doc.Call("getElementById", "startBtn").Call("addEventListener", "click", func() {
		startTimer()
	})

	doc.Call("getElementById", "stopBtn").Call("addEventListener", "click", func() {
		stopTimer()
	})

	doc.Call("getElementById", "recoverBtn").Call("addEventListener", "click", func() {
		recoverOriginalTime()
	})
}
