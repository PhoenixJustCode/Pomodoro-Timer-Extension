# 🕒 Pomodoro Timer Extension
**Pomodoro Timer Extension** — это легкое веб-приложение, написанное на Go с помощью GopherJS, предназначенное для повышения продуктивности по технике Pomodoro.

---

## 🚀 Features

- ⏱ Установка времени по клику на таймер
- ▶️ Старт и ⏸️ стоп таймера
- 🔁 Восстановление исходного времени
- 📦 Написано на Go и скомпилировано в JS через GopherJS

---

## 🛠 Technologies Used

- **Go (Golang)**
- **GopherJS** — компиляция Go → JS
- **HTML5**
- **CSS3**

---

## 📷 Interface Preview

![изображение](https://github.com/user-attachments/assets/abab064c-f2e5-4c56-8b6c-26adeed2f86d)


---


## ▶️ Usage

 -    Открой расширение в браузере.
 -    Нажми на таймер, чтобы ввести время в минутах.
 -    Нажми Start, чтобы начать.
 -    Используй Stop, чтобы приостановить таймер.
 -    Используй Recover, чтобы восстановить исходное время.

---


## 📦 Installation

 -    Установите Go и сам проект
     ```
            git clone https://github.com/PhoenixJustCode/Pomodoro-Timer-Extension ```
 -   Перейдите в нужную дерикторию
      ```bash
            cd Pomodoro-Timer-Extension/go-src
      ```
 -    Установите GopherJS:
   ```bash
          go install github.com/gopherjs/gopherjs@v1.19.0-beta1  # Or replace 'v1.19.0-beta1' with another version.
   ```

 -    Скомпилируйте Go-код в JavaScript:
      ```bash
          gopherjs build main.go
      ```
  -    Загрузите расширение в Google Chrome

---

link - gopherJS(https://github.com/gopherjs/gopherjs)
