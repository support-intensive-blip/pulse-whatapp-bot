import React from 'react';

export default function CommandsGuide({ catalog = [] }) {
  if (!catalog.length) {
    return <p className="muted">No commands loaded.</p>;
  }

  return (
    <div className="commands-guide">
      <p className="field-guide" style={{ marginBottom: '1rem' }}>
        WhatsApp commands users can send. Self-chat = Message Yourself. Contact chats are 1:1
        conversations with other people.
      </p>
      {catalog.map((group) => (
        <section key={group.category} className="command-group">
          <h3 className="command-group-title">{group.category}</h3>
          <div className="command-list">
            {group.commands.map((cmd) => (
              <article key={`${group.category}-${cmd.command}`} className="command-card">
                <div className="command-card-head">
                  <code className="command-syntax">{cmd.syntax}</code>
                  <span className="command-where">{cmd.where}</span>
                </div>
                <p className="command-title">{cmd.title}</p>
                <p className="command-desc">{cmd.description}</p>
                {cmd.examples?.length > 0 && (
                  <ul className="command-examples">
                    {cmd.examples.map((ex) => (
                      <li key={ex}>
                        <code>{ex}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
