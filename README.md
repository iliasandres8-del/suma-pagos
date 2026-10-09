# Suma de pagos · Club F10

App sencilla para sumar las transferencias que llegan al club: escoges las fotos o capturas de los comprobantes (Nequi, Bancolombia, Daviplata…) y una IA lee el valor, la fecha, la referencia y quién envió. Muestra el total por día, no cuenta dos veces un comprobante repetido y permite compartir el resumen.

- Los datos se guardan solo en el celular donde se usa.
- La lectura la hace la función `leer-comprobante` (Supabase + Gemini), protegida con PIN. Su código está en `funcion/`.
