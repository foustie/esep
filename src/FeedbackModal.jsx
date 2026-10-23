import React, { useState } from 'react'

// Форма отзыва → Netlify Forms (канал проверяемых пруфов для хакатона).
// Используется и на портале донора, и во флоу НКО.
export default function FeedbackModal({ onClose }) {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    const data = new FormData(e.target)
    // Приём отзывов жил на Netlify Forms; на Cloudflare его нет — не делаем вид, что отзыв ушёл.
    try {
      const res = await fetch('/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString(),
      })
      if (!res.ok) throw new Error()
      setSent(true)
    } catch {
      setError('Приём отзывов отключён в этом демо — отзыв не отправлен.')
    }
  }

  return (
    <div className="modal-backdrop no-print" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-label="Форма отзыва">
        {sent ? (
          <div className="fb-done">
            <h3>Спасибо! 🙌</h3>
            <p>Ваш отзыв поможет сделать Esep полезнее.</p>
            <button className="primary-btn" onClick={onClose}>Закрыть</button>
          </div>
        ) : (
          <form name="feedback" onSubmit={submit}>
            <input type="hidden" name="form-name" value="feedback" />
            <h3>Отзыв об Esep</h3>
            <label>
              Кто вы? (роль и организация)
              <input name="role" required placeholder="напр. координатор программ, ОФ «…» / грант-менеджер" />
            </label>
            <label>
              Что попробовали и что получилось?
              <textarea name="experience" required rows={3} />
            </label>
            <label>
              Чего не хватает, чтобы пользоваться этим в реальной отчётности?
              <textarea name="missing" rows={3} />
            </label>
            <label>
              Оценка от 1 до 5
              <select name="score" defaultValue="4">
                <option>5</option><option>4</option><option>3</option><option>2</option><option>1</option>
              </select>
            </label>
            <label>
              Контакт для связи (необязательно)
              <input name="contact" placeholder="телеграм / email" />
            </label>
            {error && <p className="hint" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={onClose}>Отмена</button>
              <button type="submit" className="primary-btn">Отправить</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
