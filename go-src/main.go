package main

import (
    "github.com/gopherjs/gopherjs/js"
)

func main() {
    js.Global.Get("document").Call("addEventListener", "DOMContentLoaded", func() {
        js.Global.Get("document").Call("getElementById", "title").Set("innerText", "Привет из GopherJS!")
    })
}
