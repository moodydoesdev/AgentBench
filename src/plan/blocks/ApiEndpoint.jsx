const METHOD_TRIPLE = {
  GET: "--blue",
  POST: "--green",
  PUT: "--amber",
  PATCH: "--amber",
  DELETE: "--red",
};

export function ApiEndpoint({ method = "GET", path, request, response, children }) {
  const m = method.toUpperCase();
  const triple = METHOD_TRIPLE[m] ?? "--blue";
  return (
    <figure className="plan-api">
      <div className="plan-api-head">
        <span
          className="plan-api-method"
          style={{
            color: `rgb(var(${triple}))`,
            background: `rgba(var(${triple}), 0.12)`,
          }}
        >
          {m}
        </span>
        <code className="plan-api-path">{path}</code>
      </div>
      {children && <div className="plan-api-desc">{children}</div>}
      {request && (
        <div className="plan-api-io">
          <span className="plan-api-io-label">request</span>
          <pre className="plan-code-plain">{String(request).trim()}</pre>
        </div>
      )}
      {response && (
        <div className="plan-api-io">
          <span className="plan-api-io-label">response</span>
          <pre className="plan-code-plain">{String(response).trim()}</pre>
        </div>
      )}
    </figure>
  );
}
