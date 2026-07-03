export function DataModel({ name, fields = [] }) {
  return (
    <figure className="plan-datamodel">
      <figcaption className="plan-block-title mono">{name}</figcaption>
      <table className="plan-datamodel-table">
        <tbody>
          {fields.map((f, i) => (
            <tr key={i}>
              <td className="plan-dm-name">
                {f.name}
                {f.req && <span className="plan-dm-req">*</span>}
              </td>
              <td className="plan-dm-type">{f.type}</td>
              <td className="plan-dm-desc">{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
