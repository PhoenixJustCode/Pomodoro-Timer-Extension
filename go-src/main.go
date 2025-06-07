package main

import (
	"strconv"
	"time"

	"github.com/gopherjs/gopherjs/js" // go->js
)

var (
	timerID       *js.Object
	originalMins  int    // Изначальные минуты, введённые пользователем
	remainingSecs int    // Сколько сейчас осталось
	isPaused      bool   // Включен ли таймер
	isRunning     bool   // Чтобы не запускать дважды	
	titleBtnPressed = false // для проверки на нажатие на таймер
	innerTimer = false // для внутреннего таймера
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
	clearStart()
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

func startTimer(doc *js.Object) {
	if isRunning || remainingSecs <= 0 {
		return
	}

	saveStart(remainingSecs) // ⬅ Важно

	timerID = js.Global.Call("setInterval", func() {
		remainingSecs = loadRemainingSecs() // ⬅ обновляем с внутреннего таймера
		if remainingSecs > 0 {
			updateDisplay()
		} else {
			stopTimer(doc)
			clearStart()
		}
	}, 1000)

	isPaused = false
	isRunning = true
}


func timerUpdate(doc *js.Object) {
	input := js.Global.Call("prompt", "Введите количество минут", "25")
	mins, err := strconv.Atoi(input.String())
	if err == nil && mins > 0 {
		originalMins = mins
		remainingSecs = mins * 60
		updateDisplay()
	}
}


func main() {
	updateDisplay()
	doc := js.Global.Get("document")
	remainingSecs = loadRemainingSecs()
	
	if remainingSecs > 0 && titleBtnPressed {
		updateDisplay()
		startTimer(doc)
	} else {
		remainingSecs = 0
		timerUpdate(doc)
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
			timerUpdate(doc)
			startTimer(doc)
		}
	})

	doc.Call("getElementById", "stopBtn").Call("addEventListener", "click", func() {
		stopTimer(doc)
	})

	doc.Call("getElementById", "recoverBtn").Call("addEventListener", "click", func() {
		recoverOriginalTime(doc)
	})
}
