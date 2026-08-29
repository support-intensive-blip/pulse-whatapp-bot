import { Navigate, useParams } from 'react-router-dom';

export default function ConversationDetail() {
  const { id } = useParams();
  return <Navigate to={`/conversations/${id}`} replace />;
}
