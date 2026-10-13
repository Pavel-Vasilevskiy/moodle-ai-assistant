# Moodle AI Assistant API — перший етап

Мінімальний локальний REST API на FastAPI. На цьому етапі AI, Moodle, база даних,
Docker і браузерне розширення не підключені. `POST /api/answer` повертає
повідомлення-заглушку й не визначає правильну відповідь.

## Вимоги

- Python 3.13
- pip

## Запуск у Windows PowerShell

Перейдіть у папку `backend`, створіть віртуальне середовище та встановіть залежності:

```powershell
cd backend
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Якщо PowerShell забороняє активацію середовища, виконайте для поточного вікна:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\.venv\Scripts\Activate.ps1
```

Запустіть сервер із папки `backend`:

```powershell
python -m uvicorn app.main:app
```

На деяких конфігураціях Windows спостереження за файлами (`--reload`) може
завершитися помилкою доступу. Для автоматичного перезапуску при зміні файлів
можна обмежити спостереження папкою застосунку:

```powershell
python -m uvicorn app.main:app --reload --reload-dir app
```

API буде доступне за адресою `http://127.0.0.1:8000`. Інтерактивна документація:
`http://127.0.0.1:8000/docs`.

## Тести

В окремому PowerShell вікні перейдіть у `backend`, активуйте `.venv` за потреби та запустіть:

```powershell
python -m pytest
```

## Маршрути

- `GET /health` — повертає `{"status": "ok"}`.
- `POST /api/answer` — приймає `question` і від 1 до 20 `options`. Питання має
  містити від 1 до 2000 символів, кожен варіант — від 1 до 500 символів.
  Поки AI не підключений, відповідь лишається порожньою, а `message` пояснює стан.
