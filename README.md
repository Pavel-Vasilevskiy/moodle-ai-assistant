# Moodle AI Assistant

Локальний REST API на FastAPI з інтеграцією OpenAI API та Chrome-розширенням
із Side Panel. Для локальної перевірки є тестова HTML-сторінка, що імітує кілька
типів питань. Сумісність зі справжнім Moodle ще не перевірена; автоматичне
вибирання чи надсилання відповідей відсутнє. Docker, база даних і серверне
розгортання поки не входять до проєкту.

## Вимоги

- Python 3.13
- API-ключ OpenAI та доступна для цього API-проєкту модель, що підтримує
  Responses API і Structured Outputs

## Встановлення у Windows PowerShell

```powershell
cd backend
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Якщо PowerShell забороняє активацію середовища, дозволь її лише для поточного
вікна й повтори команду активації:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\.venv\Scripts\Activate.ps1
```

## Налаштування OpenAI

Повернись у корінь репозиторію та створи локальний `.env` з шаблону:

```powershell
cd ..
Copy-Item .env.example .env
notepad .env
```

Заповни `OPENAI_API_KEY` власним API-ключем і `OPENAI_MODEL` точним ідентифікатором
моделі. Не додавай реальний `.env` до Git. Він уже виключений у `.gitignore`.
Для локального запуску API потрібен саме API-ключ OpenAI; підписка ChatGPT не є
заміною API-доступу. Створи ключ у [налаштуваннях API-ключів OpenAI](https://platform.openai.com/api-keys).

Не задавай модель навмання. Доступність залежить від API-проєкту й дозволів
облікового запису. Переглянь доступні ідентифікатори через [список моделей API](https://developers.openai.com/api/reference/resources/models/methods/list)
або `client.models.list()`, потім перевір у документації моделі підтримку
Responses API та Structured Outputs.

## Запуск сервера

З папки `backend` та з активованим `.venv`:

```powershell
python -m uvicorn app.main:app
```

API доступне на `http://127.0.0.1:8000`. На цьому комп'ютері `--reload` спричиняв
помилку Windows watcher; для звичайної роботи він не потрібен. За бажанням
можна спробувати перезапуск зі стеженням лише за папкою застосунку:

```powershell
python -m uvicorn app.main:app --reload --reload-dir app
```

## Перевірка через Swagger UI

Відкрий [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs), розгорни
`POST /api/answer`, натисни **Try it out** і надішли, наприклад:

```json
{
  "question": "Яка столиця Франції?",
  "options": ["Париж", "Рим"]
}
```

Для відкритого питання поле `options` можна пропустити або передати як `[]`.
Модель має повертати `suggested_answer`, `explanation`, `confidence` і
`needs_more_context`. `confidence` — приблизна самооцінка моделі, не виміряна
ймовірність. `answer` і `message` залишені для сумісності зі старими клієнтами.

## Pytest

У папці `backend`, з активованим `.venv`:

```powershell
python -m pytest
```

Тести підміняють OpenAI SDK і не виконують платних API-запитів. Для реального
запиту використовуй Swagger UI, коли `.env` налаштований.

## Chrome extension

Інструкції для встановлення та перевірки бічної панелі дивись у
[extension/README.md](extension/README.md).

## Типові помилки конфігурації

- `503`: відсутній `OPENAI_API_KEY` або `OPENAI_MODEL`, або модель недоступна чи
  не підтримує потрібний формат. Перевір `.env`, ідентифікатор моделі та доступи.
- `503`: OpenAI відхилив API-ключ. Перевір, що ключ належить потрібному API-проєкту.
- `429`: перевищено ліміт запитів або квоту провайдера; повтори пізніше та
  перевір ліміти/білінг API-проєкту.
- `504`: таймаут відповіді AI-провайдера.
- `502`: мережева помилка провайдера або непридатна структурована відповідь.
- `422`: FastAPI відхилив некоректний запит до AI-виклику.

Помилки API не повертають ключ, traceback або вміст запиту. Секрети й `.env`
не записуються в код, журнали чи тести.
