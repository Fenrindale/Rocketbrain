def points = [2, 3, 5]
def score = points.collect { it * 2 }.sum()
println "score=${score}"
return score
