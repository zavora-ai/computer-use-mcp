async function inner() { throw new Error('test') }
async function outer() {
  try {
    return inner()
  } catch(e) {
    console.log('caught in outer')
    return 'caught'
  }
}
outer().then(r => console.log('result:', r)).catch(e => console.log('uncaught:', e.message))
