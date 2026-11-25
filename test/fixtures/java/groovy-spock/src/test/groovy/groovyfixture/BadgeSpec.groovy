package groovyfixture

import spock.lang.Specification
import spock.lang.Unroll

class BadgeSpec extends Specification {
    @Unroll
    def "joint compilation generates #label from #name and #points"() {
        expect:
        new JavaEntry().badge(name, points) == label

        where:
        name    | points || label
        'neo'   | 3      || 'NEO:6'
        'tracy' | 5      || 'TRACY:10'
    }

    def "dynamic values preserve the actual Groovy method dispatch"() {
        given:
        def dynamic = [1, 2, 3]
        expect:
        dynamic.collect { it * 2 }.join(':') == '2:4:6'
    }
}
