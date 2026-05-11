declare module 'mapbox-gl/dist/mapbox-gl.css' {}
declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}
