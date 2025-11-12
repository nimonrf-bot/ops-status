export function Dialog({ open, onOpenChange, children }: any) { return open ? children : null; }
export function DialogTrigger({ children }: any) { return children; }
export function DialogContent(props: any) { return <div {...props} />; }
export function DialogHeader(props: any) { return <div {...props} />; }
export function DialogTitle(props: any) { return <div {...props} />; }