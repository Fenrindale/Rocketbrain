package groovyfixture

class GroovyBadge {
    String label(String source, int points) {
        def dynamic = [name: source, score: JavaEntry.score(points)]
        "${dynamic.name.toUpperCase()}:${dynamic.score}"
    }
}
